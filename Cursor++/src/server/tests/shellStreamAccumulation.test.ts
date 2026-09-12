import type { AgentServerMessage } from '../gen/agent_v1_pb'
import type { LLMMessage, LLMToolResultBlock } from '../handlers/llm/types'
import { expect, it } from 'vitest'
import { SHELL_STREAM_MAX_BYTES } from '../handlers/agent/constants'
import { appendBounded, finalizeExecTool } from '../handlers/agent/execRuntime'
import { createEphemeralSession, pushSessionMessage } from '../handlers/agent/session'
import { anthropicStateStrategy } from '../handlers/llm/stateStrategy'

/**
 * Shell 输出累积上限 — 对齐 cursor-agent-exec 的 stdout/stderr 各 1 MB cap。
 *
 * 服务端逐 chunk 累积 stdout/stderr 用于 tool result / turn blob / 内存 cache /
 * sqlite 四条路径；长输出必须有界。逐 chunk 的 delta 帧仍全量流式下发。
 */

const EXEC_MESSAGE_ID = 42

// appendBounded 头部 + 尾部各保留 512K，省略标记约 30 字符，允许略超 1 MB。
const ACCUMULATED_ALLOWANCE = SHELL_STREAM_MAX_BYTES + 64

function shellStdoutChunk(data: string): Record<string, unknown> {
  return { execClientMessage: { id: EXEC_MESSAGE_ID, shellStream: { stdout: { data } } } }
}

function shellExit(code = 0): Record<string, unknown> {
  return { execClientMessage: { id: EXEC_MESSAGE_ID, shellStream: { exit: { code, cwd: '/workspace' } } } }
}

async function runShellToolFrames(chunks: string[]): Promise<AgentServerMessage[]> {
  const session = createEphemeralSession('shell-cap-test')
  for (const chunk of chunks)
    pushSessionMessage(session, shellStdoutChunk(chunk))
  pushSessionMessage(session, shellExit())

  const pendingToolResults: LLMToolResultBlock[] = []
  const messages: LLMMessage[] = []
  const roundContext = {
    createToolResult: anthropicStateStrategy.createToolResult.bind(anthropicStateStrategy),
    recordToolResult(target: LLMMessage[], result: LLMToolResultBlock) {
      anthropicStateStrategy.addToolResult(target, pendingToolResults, result)
    },
  }

  const frames: AgentServerMessage[] = []
  const generator = finalizeExecTool({
    session,
    toolName: 'Shell',
    callId: 'call-shell-cap',
    cursorToolType: 'shellToolCall',
    execMessageId: EXEC_MESSAGE_ID,
    modelCallId: 'model-shell-cap',
    startedArgs: { command: 'big-output', toolCallId: 'call-shell-cap' },
    input: { command: 'big-output', workingDirectory: '/workspace' },
    roundContext,
    messages,
  })
  for await (const frame of generator)
    frames.push(frame)
  return frames
}

function collectStdoutDeltas(frames: AgentServerMessage[]): string[] {
  const contents: string[] = []
  for (const frame of frames) {
    if (frame.message.case !== 'interactionUpdate')
      continue
    const update = frame.message.value.message
    if (update.case !== 'toolCallDelta')
      continue
    const delta = update.value.toolCallDelta?.delta
    if (delta?.case !== 'shellToolCallDelta')
      continue
    if (delta.value.delta.case !== 'stdout' || !delta.value.delta.value)
      continue
    contents.push(delta.value.delta.value.content)
  }
  return contents
}

function findShellSuccessStdout(frames: AgentServerMessage[]): string | undefined {
  for (const frame of frames) {
    if (frame.message.case !== 'interactionUpdate')
      continue
    const update = frame.message.value.message
    if (update.case !== 'toolCallCompleted')
      continue
    const tool = update.value.toolCall?.tool
    if (tool?.case !== 'shellToolCall')
      continue
    const result = tool.value.result?.result
    if (result?.case === 'success')
      return result.value.stdout
  }
  return undefined
}

it('appendBounded keeps accumulated output bounded and preserves head/tail', () => {
  const headChunk = `HEAD_MARKER${'h'.repeat(300_000)}`
  const midChunk = 'm'.repeat(300_000)
  const tailChunk = `${'t'.repeat(300_000)}TAIL_MARKER`
  const chunks = [headChunk, midChunk, midChunk, midChunk, midChunk, tailChunk]

  let accumulated = ''
  for (const chunk of chunks)
    accumulated = appendBounded(accumulated, chunk)

  // 输入总量 ~1.8 MB，远超单流上限
  const totalInputBytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  expect(totalInputBytes).toBeGreaterThan(SHELL_STREAM_MAX_BYTES)

  expect(accumulated.length).toBeLessThanOrEqual(ACCUMULATED_ALLOWANCE)
  expect(accumulated.startsWith('HEAD_MARKER')).toBe(true)
  expect(accumulated.endsWith('TAIL_MARKER')).toBe(true)
  expect(accumulated).toContain('chars elided')
})

it('appendBounded stays bounded across many small trailing chunks', () => {
  let accumulated = 'x'.repeat(SHELL_STREAM_MAX_BYTES + 100)
  for (let i = 0; i < 200; i++)
    accumulated = appendBounded(accumulated, `chunk-${i}-${'y'.repeat(1_000)}`)

  expect(accumulated.length).toBeLessThanOrEqual(ACCUMULATED_ALLOWANCE)
  expect(accumulated.endsWith('y'.repeat(1_000))).toBe(true)
})

it('streams full stdout deltas while the accumulated shell result stays bounded', async () => {
  const firstChunk = `HEAD_MARKER${'h'.repeat(300_000)}`
  const middleChunk = 'm'.repeat(300_000)
  const lastChunk = `${'t'.repeat(300_000)}TAIL_MARKER`
  const chunks = [firstChunk, middleChunk, middleChunk, middleChunk, middleChunk, lastChunk]

  const frames = await runShellToolFrames(chunks)
  const deltas = collectStdoutDeltas(frames)

  // delta 帧不受 cap 影响 — 逐 chunk 全量下发（对齐官方行为）
  expect(deltas).toHaveLength(chunks.length)
  expect(deltas.join('')).toBe(chunks.join(''))

  const accumulatedStdout = findShellSuccessStdout(frames)
  expect(accumulatedStdout).toBeDefined()
  expect(accumulatedStdout!.length).toBeLessThanOrEqual(ACCUMULATED_ALLOWANCE)
  expect(accumulatedStdout!.startsWith('HEAD_MARKER')).toBe(true)
  expect(accumulatedStdout!.endsWith('TAIL_MARKER')).toBe(true)
  expect(accumulatedStdout).toContain('chars elided')
})

it('keeps short shell output untouched', async () => {
  const frames = await runShellToolFrames(['hello world', '\nsecond line\n'])
  const deltas = collectStdoutDeltas(frames)
  expect(deltas.join('')).toBe('hello world\nsecond line\n')

  const accumulatedStdout = findShellSuccessStdout(frames)
  expect(accumulatedStdout).toBe('hello world\nsecond line\n')
})
