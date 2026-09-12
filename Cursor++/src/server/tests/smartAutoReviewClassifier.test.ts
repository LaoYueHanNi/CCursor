import type { ProvidersConfig } from '../data/defaults'
import { expect, it, vi } from 'vitest'
import { setProvidersForTests } from '../config/providersStore'
import { classifySmartAutoReview, MISSING_CLASSIFIER_REASON } from '../handlers/agent/smartAutoReviewClassifier'
import { SMART_AUTO_REVIEW_SYSTEM_PROMPT } from '../handlers/agent/smartAutoReviewPrompt'

/**
 * Auto-review 分类器失败策略回归测试 — 两档策略:
 *   - 未配置 Haiku 4.5 (可预知场景) → fail-closed: BLOCK + 固定提示文案;
 *   - 运行时失败 (网络/调用异常等偶发场景) → fail-open: fallback allow。
 *
 * mock 目的: 已配置分类器的用例只需验证"进入调用路径后失败如何回退",
 * 不需要真实 provider; 未配置用例不应触达该调用。
 */
vi.mock('../handlers/llm', () => ({
  resolveProviderRuntime: () => {
    throw new Error('provider runtime unavailable')
  },
}))

const PROVIDERS_WITHOUT_CLASSIFIER: ProvidersConfig = {
  $schemaVersion: 1,
  providers: [
    {
      id: 'test-provider',
      name: 'Test Provider',
      type: 'anthropic',
      baseUrl: '',
      auth: { kind: 'apiKey', value: 'test-key' },
      models: [
        { id: 'claude-sonnet-4', apiModel: 'claude-sonnet-4', displayName: 'Claude Sonnet 4', thinking: false },
      ],
    },
  ],
}

const PROVIDERS_WITH_CLASSIFIER: ProvidersConfig = {
  $schemaVersion: 1,
  providers: [
    {
      id: 'test-provider',
      name: 'Test Provider',
      type: 'anthropic',
      baseUrl: '',
      auth: { kind: 'apiKey', value: 'test-key' },
      models: [
        { id: 'claude-haiku-4-5', apiModel: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5', thinking: false },
      ],
    },
  ],
}

/** 与客户端 AvailableModels 判定对齐: 显式字段为 true 的非 Haiku 命名模型同样可选。 */
const PROVIDERS_WITH_EXPLICIT_FLAG: ProvidersConfig = {
  $schemaVersion: 1,
  providers: [
    {
      id: 'test-provider',
      name: 'Test Provider',
      type: 'anthropic',
      baseUrl: '',
      auth: { kind: 'apiKey', value: 'test-key' },
      models: [
        { id: 'custom-classifier', apiModel: 'custom-classifier', displayName: 'Custom Classifier', thinking: false, supportsSmartModeClassifier: true },
      ],
    },
  ],
}

it('未配置 Haiku 4.5 分类器时 fail-closed: 返回 BLOCK 与固定提示文案', async () => {
  setProvidersForTests(PROVIDERS_WITHOUT_CLASSIFIER)
  const outcome = await classifySmartAutoReview({
    toolCallId: 'call-missing-classifier',
    target: { action: 'Shell', arguments: { command: 'git status' } },
    mode: 'auto_review',
  })
  expect(outcome.decision).toBe('block')
  expect(outcome.reason).toBe(MISSING_CLASSIFIER_REASON)
  expect(outcome.fallback).toBe(true)
})

it('已配置 Haiku 4.5 但运行时调用失败时回退 allow, 不阻塞工作流', async () => {
  setProvidersForTests(PROVIDERS_WITH_CLASSIFIER)
  const outcome = await classifySmartAutoReview({
    toolCallId: 'call-runtime-failure',
    target: { action: 'Shell', arguments: { command: 'git status' } },
    mode: 'auto_review',
  })
  expect(outcome.decision).toBe('allow')
  expect(outcome.fallback).toBe(true)
  expect(outcome.reason).toContain('provider runtime unavailable')
})

it('显式 supportsSmartModeClassifier 标注的非 Haiku 命名模型也被服务端识别 (与客户端判定一致)', async () => {
  setProvidersForTests(PROVIDERS_WITH_EXPLICIT_FLAG)
  const outcome = await classifySmartAutoReview({
    toolCallId: 'call-explicit-flag',
    target: { action: 'Shell', arguments: { command: 'git status' } },
    mode: 'auto_review',
  })
  // 找到模型后进入调用路径, mock 的 resolveProviderRuntime 抛错 → 走运行时回退而非 MISSING_CLASSIFIER
  expect(outcome.reason).not.toBe(MISSING_CLASSIFIER_REASON)
  expect(outcome.reason).toContain('provider runtime unavailable')
})

it('系统提示词保留 Claude Code 移植版骨架锚点, 且无平台专有残留', () => {
  // 关键骨架锚点 — 移植版的核心结构必须存在
  for (const anchor of [
    '## Threat Model',
    '## User Intent Rule',
    '## Evaluation Rules',
    '## HARD BLOCK',
    '## SOFT BLOCK',
    '## ALLOW (exceptions)',
    '## Classification Process',
    'Irreversible Local Destruction',
    'Data Exfiltration',
    'Git Destructive',
    'UNSEEN TOOL RESULTS',
    'Session-Created Job Cleanup',
    '[Exact BLOCK Rule Name]',
  ]) {
    expect(SMART_AUTO_REVIEW_SYSTEM_PROMPT).toContain(anchor)
  }
  // 平台专有内容必须已被裁剪/泛化 — 防止回归时带入 Claude Code 专属名词
  for (const removed of [
    'claude-in-chrome',
    'Chrome-MCP',
    '.claude/',
    'CLAUDE.md',
    'CronCreate',
    'RemoteTrigger',
    '<teammate-message>',
    'SandboxNetworkAccess',
  ]) {
    expect(SMART_AUTO_REVIEW_SYSTEM_PROMPT).not.toContain(removed)
  }
})
