/**
 * ClassifySandAutoReview 请求体防御性修正。
 *
 * 背景: Cursor 客户端 (agent-exec shell preflight) 在 Auto-review 模式下对本接口
 * 发起 Connect unary JSON 请求。2026-09-12 实测出现过一次 400 invalid_argument
 * (客户端重试一次后放弃, preflight 回退人工审批, 且用户随后的审批操作会写入
 * per-composer agentApprovalModeOverride 使 smart mode 恒为 false, 造成"全量弹人工")。
 *
 * 服务端 proto (protobuf-es) 对以下 JSON 形状直接抛 invalid_argument (实测):
 *   - attempt_index: 非整数/负数/超 uint32/bool/字符串小数
 *   - mode: 非字符串
 *   - args.tool_call_id / args.parent_conversation_id: 非字符串
 *   - args.target: 非对象; args.target.action: 非字符串;
 *     args.target.arguments (google.protobuf.Struct): 数组/字符串/其他非对象
 *   - args.conversation_context: 非数组; 数组元素为 null/非对象;
 *     元素 role/content 非字符串
 *   - 顶层/args 为数组或标量
 *
 * 本模块在 Fastify preParsing 层把这些形状修成 proto 可接受的形式,
 * 丢弃非法字段而不是拒绝整个请求 —— 分类器拿不到的字段自然走
 * "insufficient information" 路径, 语义安全。
 */

interface SanitizeResult {
    value: unknown
    /** 被丢弃/修正的字段路径, 用于日志诊断真实客户端形状 */
    dropped: string[]
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 仅保留 [0, 2^32-1] 区间的整数 */
function asUint32(v: unknown): number | undefined {
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 4294967296) return v
    return undefined
}

function sanitizeConversationMessage(item: unknown, path: string, dropped: string[]): Record<string, unknown> | undefined {
    if (!isPlainObject(item)) {
        dropped.push(`${path} (非对象元素已丢弃)`)
        return undefined
    }
    const out: Record<string, unknown> = {}
    if (typeof item.role === 'string') {
        out.role = item.role
    }
    else if ('role' in item) {
        dropped.push(`${path}.role (非字符串已丢弃)`)
    }
    if (typeof item.content === 'string') {
        out.content = item.content
    }
    else if ('content' in item) {
        dropped.push(`${path}.content (非字符串已丢弃)`)
    }
    return out
}

function sanitizeArgs(args: unknown, dropped: string[]): Record<string, unknown> {
    if (!isPlainObject(args)) {
        dropped.push('args (非对象已重置为空)')
        return {}
    }
    const out: Record<string, unknown> = {}
    if (typeof args.toolCallId === 'string') {
        out.toolCallId = args.toolCallId
    }
    else if ('toolCallId' in args) {
        dropped.push('args.toolCallId (非字符串已丢弃)')
    }
    if (typeof args.parentConversationId === 'string') {
        out.parentConversationId = args.parentConversationId
    }
    else if ('parentConversationId' in args && args.parentConversationId !== undefined) {
        dropped.push('args.parentConversationId (非字符串已丢弃)')
    }
    if (args.target !== undefined) {
        if (isPlainObject(args.target)) {
            const target: Record<string, unknown> = {}
            if (typeof args.target.action === 'string') {
                target.action = args.target.action
            }
            else if ('action' in args.target) {
                dropped.push('args.target.action (非字符串已丢弃)')
            }
            // google.protobuf.Struct 只接受 JSON 对象; null 视为未设置可直接丢弃
            if (isPlainObject(args.target.arguments)) {
                target.arguments = args.target.arguments
            }
            else if (args.target.arguments !== undefined) {
                dropped.push('args.target.arguments (非对象已丢弃)')
            }
            out.target = target
        }
        else {
            dropped.push('args.target (非对象已丢弃)')
        }
    }
    if (args.conversationContext !== undefined) {
        if (Array.isArray(args.conversationContext)) {
            const list = args.conversationContext
                .map((item, i) => sanitizeConversationMessage(item, `args.conversationContext[${i}]`, dropped))
                .filter((m): m is Record<string, unknown> => m !== undefined)
            out.conversationContext = list
        }
        else {
            dropped.push('args.conversationContext (非数组已丢弃)')
        }
    }
    return out
}

/**
 * 修正 ClassifySandAutoReviewRequest 的 JSON 形状。
 * 输入已被 JSON.parse; 任何 proto3 无法解码的形状都会被修剪为可解码形式。
 */
export function sanitizeClassifyRequestBody(parsed: unknown): SanitizeResult {
    const dropped: string[] = []
    if (!isPlainObject(parsed)) {
        return { value: {}, dropped: ['<root> (非对象已重置为空)'] }
    }
    const out: Record<string, unknown> = {}
    if (parsed.args !== undefined) {
        out.args = sanitizeArgs(parsed.args, dropped)
    }
    const attempt = asUint32(parsed.attemptIndex)
    if (attempt !== undefined) {
        out.attemptIndex = attempt
    }
    else if (parsed.attemptIndex !== undefined && parsed.attemptIndex !== null) {
        dropped.push(`attemptIndex (${JSON.stringify(parsed.attemptIndex)} 已丢弃)`)
    }
    if (typeof parsed.mode === 'string') {
        out.mode = parsed.mode
    }
    else if ('mode' in parsed && parsed.mode !== undefined && parsed.mode !== null) {
        dropped.push(`mode (${JSON.stringify(parsed.mode)} 已丢弃)`)
    }
    return { value: out, dropped }
}
