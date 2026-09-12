import type { AgentServerMessage } from '../gen/agent_v1_pb'
import type { ReadOnlyToolLaunchContext } from '../handlers/agent/toolRuntime'
import type { LLMMessage, LLMToolResultBlock } from '../handlers/llm/types'
import { expect, it } from 'vitest'
import { createEphemeralSession, pushSessionMessage } from '../handlers/agent/session'
import {
  finalizeLaunchedReadOnlyTool,
  isReadOnlyToolLaunchEligible,
  launchReadOnlyTool,
  runToolCall,
} from '../handlers/agent/toolRuntime'
import { awaitExecResultAndClose } from '../handlers/agent/wait'
import { anthropicStateStrategy } from '../handlers/llm/stateStrategy'

/**
 * 只读工具三段式并发（Phase 2a launch / 2b wait / 2c finalize）。
 *
 * 只读白名单 = execArgsType ∈ {readArgs, grepArgs, diagnosticsArgs} 且非 awaitToolCall。
 * 覆盖 Read/Grep/Glob/ReadLints；Shell（审批不可预知）、Edit、交互工具保持串行。
 */

function createTestRoundContext() {
  const pendingToolResults: LLMToolResultBlock[] = []
  return {
    pendingToolResults,
    createToolResult: anthropicStateStrategy.createToolResult.bind(anthropicStateStrategy),
    recordToolResult(messages: LLMMessage[], result: LLMToolResultBlock) {
      anthropicStateStrategy.addToolResult(messages, pendingToolResults, result)
    },
  }
}

function readToolCall(callId: string, path: string) {
  return { callId, name: 'Read', input: { path } }
}

function readResultMessage(execMessageId: number, path: string, content: string) {
  return {
    execClientMessage: {
      id: execMessageId,
      readResult: {
        success: {
          path,
          content,
          totalLines: 1,
          fileSize: String(content.length),
        },
      },
    },
  }
}

function streamCloseMessage(execMessageId: number) {
  return { execClientControlMessage: { streamClose: { id: execMessageId } } }
}

function startedCallId(frame: AgentServerMessage): string | undefined {
  if (frame.message.case !== 'interactionUpdate')
    return undefined
  const update = frame.message.value.message
  if (update.case !== 'toolCallStarted')
    return undefined
  return update.value.callId
}

function completedCallId(frame: AgentServerMessage): string | undefined {
  if (frame.message.case !== 'interactionUpdate')
    return undefined
  const update = frame.message.value.message
  if (update.case !== 'toolCallCompleted')
    return undefined
  return update.value.callId
}

async function drainLaunch(
  generator: AsyncGenerator<AgentServerMessage, ReadOnlyToolLaunchContext | null, void>,
): Promise<{ frames: AgentServerMessage[], ctx: ReadOnlyToolLaunchContext | null }> {
  const frames: AgentServerMessage[] = []
  let step = await generator.next()
  while (!step.done) {
    frames.push(step.value)
    step = await generator.next()
  }
  return { frames, ctx: step.value }
}

it('admits only read/grep/diagnostics exec tools into the concurrent batch', () => {
  const eligibleCases: Array<[string, Record<string, unknown>]> = [
    ['Read', { path: 'a.ts' }],
    ['Grep', { pattern: 'needle', path: '.' }],
    ['Glob', { globPattern: '**/*.ts' }],
    ['ReadLints', { paths: ['a.ts'] }],
  ]
  for (const [name, input] of eligibleCases) {
    expect(
      isReadOnlyToolLaunchEligible({ toolCall: { callId: `call-${name}`, name, input }, availableMcpTools: [] }),
      `${name} should be eligible`,
    ).toBe(true)
  }

  const rejectedCases: Array<[string, Record<string, unknown>]> = [
    ['Edit', { path: 'a.ts', old_string: 'x', new_string: 'y' }],
    ['Shell', { command: 'ls' }],
    ['AwaitShell', { task_id: '42' }],
    ['CallDynamicTool', { namespace: 'cursor', toolName: 'Read' }],
  ]
  for (const [name, input] of rejectedCases) {
    expect(
      isReadOnlyToolLaunchEligible({ toolCall: { callId: `call-${name}`, name, input }, availableMcpTools: [] }),
      `${name} must stay serial`,
    ).toBe(false)
  }
})

it('launches read-only tools concurrently and finalizes their results in call order', async () => {
  const session = createEphemeralSession('read-only-concurrency')
  let execCounter = 100
  const allocateExecMessageId = () => ++execCounter
  const roundContext = createTestRoundContext()
  const messages: LLMMessage[] = []

  const launchParams = {
    availableMcpTools: [],
    conversationId: 'conv-read-only',
    currentModelId: 'claude-sonnet-4',
    round: 0,
    session,
    roundContext,
    messages,
    allocateExecMessageId,
  }

  // Phase 2a: 两次 launch 都不等待结果 —— 只发 started + exec 帧
  const first = await drainLaunch(launchReadOnlyTool({ ...launchParams, toolCall: readToolCall('call-read-1', 'a.ts') }))
  const second = await drainLaunch(launchReadOnlyTool({ ...launchParams, toolCall: readToolCall('call-read-2', 'b.ts') }))

  expect(first.ctx).toBeTruthy()
  expect(second.ctx).toBeTruthy()
  const launches = [first.ctx!, second.ctx!]
  expect(launches[0]!.execMessageId).not.toBe(launches[1]!.execMessageId)

  const launchFrames = [...first.frames, ...second.frames]
  expect(launchFrames.filter(frame => startedCallId(frame) !== undefined).map(startedCallId)).toEqual(['call-read-1', 'call-read-2'])
  const execFrames = launchFrames.filter(frame => frame.message.case === 'execServerMessage')
  expect(execFrames).toHaveLength(2)
  expect(launchFrames.filter(frame => completedCallId(frame) !== undefined)).toHaveLength(0)

  // Phase 2b: 并发等待（结果在 launch 之后才推入，验证 launch 阶段确实未等待）
  pushSessionMessage(session, readResultMessage(launches[0]!.execMessageId, 'a.ts', 'content-a'))
  pushSessionMessage(session, readResultMessage(launches[1]!.execMessageId, 'b.ts', 'content-b'))
  pushSessionMessage(session, streamCloseMessage(launches[0]!.execMessageId))
  pushSessionMessage(session, streamCloseMessage(launches[1]!.execMessageId))
  const results = await Promise.all(launches.map(ctx => awaitExecResultAndClose(session, ctx.execMessageId)))

  // Phase 2c: 按启动顺序逐个收尾
  const completedFrames = launches.map((ctx, index) =>
    finalizeLaunchedReadOnlyTool(ctx, results[index]!, roundContext, messages),
  )
  expect(completedFrames.map(completedCallId)).toEqual(['call-read-1', 'call-read-2'])
  // Anthropic state strategy 先把 tool result 攒进 pending，保证结果顺序与调用顺序一致
  expect(roundContext.pendingToolResults.map(result => result.toolUseId)).toEqual(['call-read-1', 'call-read-2'])
})

it('runs a serial Edit only after the read-only batch has been finalized', async () => {
  const session = createEphemeralSession('read-only-with-edit')
  let execCounter = 100
  const allocateExecMessageId = () => ++execCounter
  const roundContext = createTestRoundContext()
  const messages: LLMMessage[] = []

  const launchParams = {
    availableMcpTools: [],
    conversationId: 'conv-mixed',
    currentModelId: 'claude-sonnet-4',
    round: 0,
    session,
    roundContext,
    messages,
    allocateExecMessageId,
  }

  // 分流：只读进并发批，Edit 留在串行 fallback
  const readCalls = [readToolCall('call-read-a', 'a.ts'), readToolCall('call-read-c', 'c.ts')]
  const editCall = { callId: 'call-edit-b', name: 'Edit', input: { path: 'b.ts', old_string: 'old', new_string: 'new' } }
  const concurrentBatch = [readCalls[0]!, editCall, readCalls[1]!].filter(tc =>
    isReadOnlyToolLaunchEligible({ toolCall: tc, availableMcpTools: [] }),
  )
  expect(concurrentBatch.map(tc => tc.callId)).toEqual(['call-read-a', 'call-read-c'])

  // 只读批：launch + 并发等待 + 顺序收尾
  const launches: ReadOnlyToolLaunchContext[] = []
  const readFrames: AgentServerMessage[] = []
  for (const tc of concurrentBatch) {
    const { frames, ctx } = await drainLaunch(launchReadOnlyTool({ ...launchParams, toolCall: tc }))
    readFrames.push(...frames)
    if (ctx)
      launches.push(ctx)
  }
  for (const ctx of launches) {
    pushSessionMessage(session, readResultMessage(ctx.execMessageId, 'x.ts', `content-${ctx.tc.callId}`))
    pushSessionMessage(session, streamCloseMessage(ctx.execMessageId))
  }
  const results = await Promise.all(launches.map(ctx => awaitExecResultAndClose(session, ctx.execMessageId)))
  for (let i = 0; i < launches.length; i++)
    readFrames.push(finalizeLaunchedReadOnlyTool(launches[i]!, results[i]!, roundContext, messages))

  // 串行 fallback：Edit 需要 client read/write 往返，预推对应消息
  const editReadExecId = 201
  const editWriteExecId = 202
  pushSessionMessage(session, {
    execClientMessage: {
      id: editReadExecId,
      readResult: { success: { path: 'b.ts', content: 'old\n', totalLines: 1, fileSize: '4' } },
    },
  })
  pushSessionMessage(session, streamCloseMessage(editReadExecId))
  pushSessionMessage(session, {
    execClientMessage: {
      id: editWriteExecId,
      writeResult: { success: { path: 'b.ts', linesCreated: 1, fileSize: 4 } },
    },
  })
  pushSessionMessage(session, streamCloseMessage(editWriteExecId))

  // Edit 的 exec 交互预推消息用独立 id 空间（201/202），分配器必须与之对齐
  let editExecCounter = 200
  const editFrames: AgentServerMessage[] = []
  const editIterator = runToolCall({
    toolCall: editCall,
    availableMcpTools: [],
    conversationId: 'conv-mixed',
    currentModelId: 'claude-sonnet-4',
    round: 0,
    session,
    roundContext,
    messages,
    allocateExecMessageId: () => ++editExecCounter,
    allocateInteractionId: () => 1,
  })
  for await (const frame of editIterator)
    editFrames.push(frame)

  // 帧顺序：只读 completed 全部先于 Edit 的 started
  const allFrames = [...readFrames, ...editFrames]
  let lastReadCompletedIndex = -1
  for (let i = 0; i < allFrames.length; i++) {
    if (completedCallId(allFrames[i]!) === 'call-read-c')
      lastReadCompletedIndex = i
  }
  const editStartedIndex = allFrames.findIndex(frame => startedCallId(frame) === 'call-edit-b')
  expect(lastReadCompletedIndex).toBeGreaterThan(-1)
  expect(editStartedIndex).toBeGreaterThan(lastReadCompletedIndex)
  expect(roundContext.pendingToolResults.map(result => result.toolUseId)).toEqual([
    'call-read-a',
    'call-read-c',
    'call-edit-b',
  ])
})
