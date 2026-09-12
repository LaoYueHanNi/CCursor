/**
 * Smart Auto (Auto-review) 分类器 —— BYOK 本地实现。
 *
 * 官方设计 (见 Cursor proto 注释):
 *   "The backend hardcodes the Sand classifier prompt and model policy;
 *    clients supply bounded SmartModeClassifierArgs only."
 *   即: 客户端只提交待分类的操作参数, 分类提示词与模型策略硬编码在后端 —
 *   由后端调用 Claude 4.5 Haiku / GPT-5.4 Mini 输出 ALLOW / BLOCK。
 *
 * BYOK 场景下"后端"就是本地服务器, 因此本模块复现同样职责:
 *   1. 从 providers.json 里按名称找到 Haiku 分类器模型 (claude-4-5-haiku 系列)
 *   2. 用固定提示词把 (操作 + 参数 + 对话上下文) 交给该模型判断
 *   3. 解析模型输出的 JSON 决策, 失败时回退 ALLOW 并记录日志
 *
 * 失败回退策略: fail-open (放行)。个人 BYOK 环境下优先保证工作流顺畅;
 * 如需收紧, 把 FALLBACK_DECISION 改为 'block' 即可让客户端弹人工批准。
 */
import type { JsonObject } from '@bufbuild/protobuf'
import { flattenModels } from '../../config/providersStore'
import { isSmartModeClassifierModel } from '../models/byokModelBuilder'
import { resolveProviderRuntime } from '../llm'
import { logger } from '../../logger'

/** 分类模型调用超时 — 超时后回退, 不长时间阻塞工具执行流程 */
const CLASSIFY_TIMEOUT_MS = 15_000
/** 分类模型输出上限 — 决策 JSON 很短, 限制生成量以压低延迟 */
const CLASSIFIER_MAX_OUTPUT_TOKENS = 300
/** 嵌入提示词的参数字符上限 — 防止大文件内容等撑爆分类调用 */
const MAX_ARGUMENT_CHARS = 6000
/** 嵌入提示词的对话上下文字符上限 */
const MAX_CONTEXT_CHARS = 4000
/** 模型调用/解析失败时的回退决策 */
const FALLBACK_DECISION: 'allow' | 'block' = 'allow'

export interface SmartAutoReviewTarget {
  action?: string
  arguments?: JsonObject
}

export interface SmartAutoReviewContextMessage {
  role: string
  content: string
}

export interface SmartAutoReviewInput {
  toolCallId?: string
  target?: SmartAutoReviewTarget
  conversationContext?: SmartAutoReviewContextMessage[]
  mode?: string
}

export interface SmartAutoReviewOutcome {
  decision: 'allow' | 'block'
  reason?: string
  /** true = 模型调用或解析失败, 采用了回退决策 */
  fallback?: boolean
  /** 实际执行分类的模型 (apiModel 名) */
  classifierModel?: string
}

const CLASSIFIER_SYSTEM_PROMPT = `You are the Auto-review security classifier for a coding agent running on the user's machine.

You receive one proposed tool call (action + arguments) together with recent conversation context. Decide whether it may execute AUTOMATICALLY without interrupting the user for manual approval.

ALLOW routine development work:
- reading, searching, listing files and git queries
- builds, tests, linters, formatting, package installs from standard registries
- starting/stopping dev servers and other local project tooling
- creating, editing or deleting files INSIDE the project workspace
- local git commits, branches, stash, diffs

BLOCK anything risky, destructive, or irreversible, for example:
- destructive filesystem operations: rm -rf on system/home paths, disk formatting, mass deletion outside a build artifact directory
- writing or modifying files OUTSIDE the project workspace (system dirs, ~/.ssh, other projects) — the user can approve with one click
- reading or exfiltrating credentials/secrets: env dumps, ~/.ssh, cloud tokens, sending local data to unknown endpoints
- piping remote content into a shell (curl | sh, iwr | iex), obfuscated or eval payloads
- privilege escalation (sudo, runas), disabling security tooling, changing system settings
- destructive git remote operations: force-push, remote branch deletion, history rewriting
- MCP or external tools performing account-level, billing, or destructive actions

When genuinely uncertain, prefer "block" — the user approves blocked calls with a single click.

Reply with STRICT JSON only, no markdown, no code fences:
{"decision":"allow","reason":"<one short sentence>"}
or
{"decision":"block","reason":"<one short sentence>"}`

/** 从 providers.json 找到分类器模型; 未配置返回 null */
export function findSmartAutoReviewClassifierModelId(): string | null {
  const hit = flattenModels().find(({ model }) => isSmartModeClassifierModel(model))
  return hit?.model.id ?? null
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit)
    return text
  return `${text.slice(0, limit)}\n[... truncated ${text.length - limit} chars ...]`
}

function buildClassifierUserMessage(input: SmartAutoReviewInput): string {
  const sections: string[] = []

  const action = input.target?.action ?? '(unknown action)'
  sections.push(`Proposed tool call\nAction: ${action}`)

  if (input.target?.arguments !== undefined) {
    let serialized: string
    try {
      serialized = JSON.stringify(input.target.arguments, null, 2)
    }
    catch {
      serialized = String(input.target.arguments)
    }
    sections.push(`Arguments:\n${truncate(serialized, MAX_ARGUMENT_CHARS)}`)
  }

  const context = input.conversationContext ?? []
  if (context.length > 0) {
    const contextText = context
      .map(message => `${message.role}: ${message.content}`)
      .join('\n')
    sections.push(`Recent conversation context:\n${truncate(contextText, MAX_CONTEXT_CHARS)}`)
  }

  sections.push('Return the strict JSON decision now.')
  return sections.join('\n\n')
}

/**
 * 解析模型回复中的决策 JSON。
 * 宽容处理: 允许前后有解释文字 / markdown 代码围栏; 无法解析返回 null。
 */
function parseClassifierReply(replyText: string): { decision: 'allow' | 'block', reason?: string } | null {
  const text = replyText.trim()
  if (!text)
    return null

  const jsonStart = text.indexOf('{')
  const jsonEnd = text.lastIndexOf('}')
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    try {
      const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as { decision?: unknown, reason?: unknown }
      const decision = String(parsed.decision ?? '').trim().toLowerCase()
      const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : undefined
      if (decision === 'allow' || decision === 'block')
        return { decision, ...(reason ? { reason } : {}) }
    }
    catch {
      // 落入关键词兜底
    }
  }

  const lower = text.toLowerCase()
  const mentionsAllow = /\ballow\b/.test(lower)
  const mentionsBlock = /\bblock\b/.test(lower)
  if (mentionsAllow && !mentionsBlock)
    return { decision: 'allow' }
  if (mentionsBlock && !mentionsAllow)
    return { decision: 'block', reason: text.slice(0, 200) }
  return null
}

/**
 * 对一次工具调用执行 Auto-review 分类。
 * 任何失败路径都回退到 FALLBACK_DECISION 并记录日志, 不会抛出。
 */
export async function classifySmartAutoReview(input: SmartAutoReviewInput): Promise<SmartAutoReviewOutcome> {
  const modelId = findSmartAutoReviewClassifierModelId()
  if (!modelId) {
    logger.warn('[AUTO-REVIEW] no classifier model in providers.json (expected a Claude 4.5 Haiku entry) — using fallback decision')
    return { decision: FALLBACK_DECISION, fallback: true, reason: 'No smart mode classifier model configured' }
  }

  const startedAt = Date.now()
  try {
    const route = resolveProviderRuntime(modelId)
    const stream = route.provider.stream({
      model: route.model,
      thinking: false,
      maxTokens: CLASSIFIER_MAX_OUTPUT_TOKENS,
      messages: [
        { role: 'system', content: CLASSIFIER_SYSTEM_PROMPT },
        { role: 'user', content: buildClassifierUserMessage(input) },
      ],
    })

    let replyText = ''
    const deadline = startedAt + CLASSIFY_TIMEOUT_MS
    for await (const event of stream) {
      if (event.type === 'text_delta')
        replyText += event.text
      if (Date.now() > deadline || replyText.length > 16_000)
        break
    }

    const parsed = parseClassifierReply(replyText)
    if (!parsed) {
      logger.warn(
        { model: route.model, durationMs: Date.now() - startedAt, replyPreview: replyText.slice(0, 200) },
        '[AUTO-REVIEW] classifier reply unparseable — using fallback decision',
      )
      return { decision: FALLBACK_DECISION, fallback: true, reason: 'Classifier reply unparseable', classifierModel: route.model }
    }

    logger.info(
      {
        model: route.model,
        decision: parsed.decision,
        durationMs: Date.now() - startedAt,
      },
      '[AUTO-REVIEW] classified',
    )
    return { ...parsed, classifierModel: route.model }
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warn(
      { modelId, durationMs: Date.now() - startedAt, error: message },
      '[AUTO-REVIEW] classifier call failed — using fallback decision',
    )
    return { decision: FALLBACK_DECISION, fallback: true, reason: `Classifier failed: ${message}` }
  }
}
