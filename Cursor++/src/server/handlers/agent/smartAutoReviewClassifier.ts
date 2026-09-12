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
 *   1. 从 providers.json 找到分类器模型 (supportsSmartModeClassifier 显式字段优先,
 *      否则按名称识别 Haiku 4.5 系列 — 与客户端 AvailableModels 的可选性判定共用,
 *      见 byokModelBuilder.hasSmartModeClassifierCapability)
 *   2. 用固定提示词把 (操作 + 参数 + 对话上下文) 交给该模型判断
 *   3. 解析模型输出的 JSON 决策, 失败时按下方策略回退并记录日志
 *
 * 系统提示词 (SMART_AUTO_REVIEW_SYSTEM_PROMPT) 移植自 Claude Code Auto-Mode
 * 权限分类器, 保留 HARD/SOFT BLOCK 分级、用户意图规则、ALLOW 强制例外与
 * 分类流程等完整骨架, 详见 smartAutoReviewPrompt.ts。
 *
 * 失败回退策略分两档:
 *   - 未配置 Haiku 4.5 分类器 (可预知场景) → fail-closed: 固定返回 BLOCK,
 *     客户端对每条命令弹人工审批卡并提示配置模型, 避免无分类能力时静默放行;
 *   - 运行时失败 (网络/超时/解析失败, 偶发场景) → 回退 FALLBACK_DECISION,
 *     默认 fail-open (放行) 优先保证工作流顺畅; 如需收紧改为 'block' 即可。
 */
import type { JsonObject } from '@bufbuild/protobuf'
import { flattenModels } from '../../config/providersStore'
import { hasSmartModeClassifierCapability } from '../models/byokModelBuilder'
import { resolveProviderRuntime } from '../llm'
import { logger } from '../../logger'
import { SMART_AUTO_REVIEW_SYSTEM_PROMPT } from './smartAutoReviewPrompt'

/** 分类模型调用超时 — 超时后回退, 不长时间阻塞工具执行流程 */
const CLASSIFY_TIMEOUT_MS = 15_000
/** 分类模型输出上限 — 决策 JSON 很短, 限制生成量以压低延迟 */
const CLASSIFIER_MAX_OUTPUT_TOKENS = 300
/** 嵌入提示词的参数字符上限 — 防止大文件内容等撑爆分类调用 */
const MAX_ARGUMENT_CHARS = 6000
/** 嵌入提示词的对话上下文字符上限 */
const MAX_CONTEXT_CHARS = 4000
/** 运行时调用/解析失败 (偶发) 时的回退决策 — 未配置模型场景不走此路径 */
const FALLBACK_DECISION: 'allow' | 'block' = 'allow'
/**
 * 未配置 Haiku 4.5 分类器时的固定阻止理由 (fail-closed)。
 * 客户端审批卡会原样展示此文案, 引导用户先补齐分类器模型再启用 Auto-review。
 */
export const MISSING_CLASSIFIER_REASON = '请配置haiku4.5模型,先分析再改动'

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
  /** true = 未执行成功分类 (未配置模型/调用失败/解析失败), 采用了非模型判定 */
  fallback?: boolean
  /** 实际执行分类的模型 (apiModel 名) */
  classifierModel?: string
}

/**
 * 从 providers.json 找到分类器模型; 未配置返回 null。
 *
 * 判定与客户端 AvailableModels 的 supports_smart_mode_classifier 完全一致
 * (见 hasSmartModeClassifierCapability) —— 客户端只有在该字段为 true 的模型
 * 存在时才允许开启 Auto-review, 两边共用判定才能保证"客户端可开 ⟺ 服务端可分类"。
 */
export function findSmartAutoReviewClassifierModelId(): string | null {
  const hit = flattenModels().find(({ model }) => hasSmartModeClassifierCapability(model))
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
 * 不会抛出: 未配置分类器模型时 fail-closed (BLOCK + 固定提示),
 * 运行时失败时回退 FALLBACK_DECISION, 均记录日志。
 */
export async function classifySmartAutoReview(input: SmartAutoReviewInput): Promise<SmartAutoReviewOutcome> {
  const modelId = findSmartAutoReviewClassifierModelId()
  if (!modelId) {
    logger.warn(
      '[AUTO-REVIEW] no classifier model in providers.json (expected a Claude 4.5 Haiku entry) — blocking every call until one is configured',
    )
    return { decision: 'block', fallback: true, reason: MISSING_CLASSIFIER_REASON }
  }

  const startedAt = Date.now()
  try {
    const route = resolveProviderRuntime(modelId)
    const stream = route.provider.stream({
      model: route.model,
      thinking: false,
      maxTokens: CLASSIFIER_MAX_OUTPUT_TOKENS,
      messages: [
        { role: 'system', content: SMART_AUTO_REVIEW_SYSTEM_PROMPT },
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
