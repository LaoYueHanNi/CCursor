import type { ProviderEntry } from '../data/defaults'
import type { LLMStreamEvent, LLMStreamRequest } from '../handlers/llm/types'
import { describe, expect, it, vi } from 'vitest'

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }))

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: createMock } }
  },
}))

const { OpenAIChatProvider } = await import('../handlers/llm/openai-chat')

const entry = {
  id: 'test',
  name: 'test',
  type: 'openai-chat',
  baseUrl: 'http://127.0.0.1:48744/v1',
  auth: { kind: 'apiKey', value: 'k' },
  models: [],
} as unknown as ProviderEntry

const request: LLMStreamRequest = {
  model: 'deepseek-v4.1-flash',
  messages: [{ role: 'user', content: 'hi' }],
}

function chunk(delta: Record<string, unknown>, finishReason: string | null = null) {
  return { choices: [{ index: 0, delta, finish_reason: finishReason }] }
}

async function* streamOf(chunks: unknown[]) {
  for (const c of chunks) yield c
}

async function collect(chunks: unknown[]): Promise<LLMStreamEvent[]> {
  createMock.mockResolvedValueOnce(streamOf(chunks))
  const out: LLMStreamEvent[] = []
  for await (const event of new OpenAIChatProvider(entry).stream(request)) out.push(event)
  return out
}

function thinkingText(events: LLMStreamEvent[]) {
  return events.filter(e => e.type === 'thinking_delta').map(e => (e as { text: string }).text).join('')
}

describe('openai-chat provider — reasoning_content 解析', () => {
  it('reasoning_content 增量转为 thinking_delta，首个正文前补 thinking_done', async () => {
    const events = await collect([
      chunk({ role: 'assistant', content: null, reasoning_content: '' }),
      chunk({ content: null, reasoning_content: '设鸡 x' }),
      chunk({ content: null, reasoning_content: ' 兔 y' }),
      chunk({ content: '鸡 23', reasoning_content: '' }),
      chunk({ content: '，兔 12', reasoning_content: '' }, 'stop'),
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ])
    expect(events.map(e => e.type)).toEqual([
      'thinking_delta',
      'thinking_delta',
      'thinking_done',
      'text_delta',
      'text_delta',
      'done',
    ])
    expect(thinkingText(events)).toBe('设鸡 x 兔 y')
  })

  it('openRouter 风格的 reasoning 字段同样识别', async () => {
    const events = await collect([
      chunk({ reasoning: 'think' }),
      chunk({ content: 'answer' }, 'stop'),
    ])
    expect(events.map(e => e.type)).toEqual(['thinking_delta', 'thinking_done', 'text_delta', 'done'])
  })

  it('只有思考没有正文时在 done 前补 thinking_done', async () => {
    const events = await collect([
      chunk({ reasoning_content: 'only thinking' }, 'stop'),
    ])
    expect(events.map(e => e.type)).toEqual(['thinking_delta', 'thinking_done', 'done'])
  })

  it('tool_calls 到达时先关闭思考', async () => {
    const events = await collect([
      chunk({ reasoning_content: 'need a tool' }),
      chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read', arguments: '{}' } }] }),
      chunk({}, 'tool_calls'),
    ])
    expect(events.map(e => e.type)).toEqual([
      'thinking_delta',
      'thinking_done',
      'tool_use_start',
      'tool_use_delta',
      'tool_use_done',
      'done',
    ])
  })

  it('无思考字段时不产生 thinking 事件', async () => {
    const events = await collect([
      chunk({ role: 'assistant', content: '' }),
      chunk({ content: 'plain' }, 'stop'),
    ])
    expect(events.map(e => e.type)).toEqual(['text_delta', 'done'])
  })

  it('空 tool_calls 数组不提前关闭思考, 也不误报 stopReason', async () => {
    const events = await collect([
      chunk({ reasoning_content: 'wait for tool' }),
      chunk({ tool_calls: [] }),
      chunk({ content: 'answer' }, 'stop'),
    ])
    expect(events.map(e => e.type)).toEqual(['thinking_delta', 'thinking_done', 'text_delta', 'done'])
    const doneEvent = events[events.length - 1] as { type: string, stopReason: string }
    expect(doneEvent.stopReason).toBe('end_turn')
  })
})
