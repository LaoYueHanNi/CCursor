/**
 * OpenAI GPT Provider
 *
 * 实现 LLMProvider 接口，封装 openai SDK。
 * 支持 tool_calls, streaming, 以及 OpenAI 兼容端点。
 */
import OpenAI from 'openai';
import type { ChatCompletionChunk, ChatCompletionCreateParamsStreaming } from 'openai/resources/chat/completions';
import type { ProviderEntry } from '../../data/defaults';
import { logger } from '../../logger';
import type { LLMProvider, LLMStreamRequest, LLMStreamEvent } from './types';
import { encodeOpenAIRequestMessages, encodeOpenAITools } from './conversationCodec';
import { createProxiedFetch } from './proxyFetch';
import { createTransformDiagnostics, hasTransformMutations, transformMessages } from './transformMessages';
import { buildDefaultHeaders } from './userAgent';

export class OpenAIChatProvider implements LLMProvider {
    readonly name = 'openai-chat';
    private client: OpenAI;

    constructor(entry: ProviderEntry) {
        const opts: ConstructorParameters<typeof OpenAI>[0] = {
            apiKey: entry.auth.value,
        };
        if (entry.baseUrl) {
            opts.baseURL = entry.baseUrl;
        }
        opts.fetch = createProxiedFetch(entry.proxyUrl);
        const headers = buildDefaultHeaders('openai-chat', entry.headers);
        if (headers) {
            opts.defaultHeaders = headers;
        }
        this.client = new OpenAI(opts);
    }

    async *stream(request: LLMStreamRequest): AsyncIterable<LLMStreamEvent> {
        const diagnostics = createTransformDiagnostics('openai-chat', request.messages.length);
        const transformed = transformMessages(request.messages, 'openai-chat', diagnostics, request.model);
        if (hasTransformMutations(diagnostics)) {
            logger.debug({
                provider: 'openai-chat',
                model: request.model,
                ...diagnostics,
            }, '[HISTORY_REPAIR] provider conversation transformed');
        }
        const params: ChatCompletionCreateParamsStreaming = {
            model: request.model,
            messages: encodeOpenAIRequestMessages(transformed),
            max_tokens: request.maxTokens ?? 8192,
            stream: true,
            stream_options: { include_usage: true },
            ...(request.conversationId ? { prompt_cache_key: request.conversationId } : {}),
        };

        const tools = encodeOpenAITools(request.tools);
        if (tools) {
            params.tools = tools;
        }

        // OpenAI reasoning_effort: minimal | low | medium | high | xhigh | max
        if (request.thinkingLevel) {
            params.reasoning_effort = request.thinkingLevel;
        }

        const stream = await this.client.chat.completions.create(params);

        const toolCalls = new Map<number, { id: string; name: string; args: string }>();
        let usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number } | null = null;
        let sawToolCalls = false;
        // reasoning_content (DeepSeek/Qwen 等) / reasoning (OpenRouter) 只在正文之前出现;
        // 首个正文或 tool_call 到达即视为思考结束, 需补发 thinking_done 才会入历史
        let thinkingOpen = false;

        for await (const chunk of stream) {
            if (chunk.usage) {
                const cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
                usage = {
                    inputTokens: chunk.usage.prompt_tokens,
                    outputTokens: chunk.usage.completion_tokens,
                    cacheReadTokens: cachedTokens || undefined,
                };
                if (cachedTokens) {
                    logger.info({
                        model: request.model,
                        cached: cachedTokens,
                        input: chunk.usage.prompt_tokens,
                    }, '[OAI_CHAT] prompt cache');
                }
            }

            const choice = chunk.choices?.[0];
            const delta = choice?.delta;
            if (!delta) continue;

            // 正文之后若代理再次输出 reasoning 会重新打开思考段 (多段思考),
            // 产生新的 thinking 块; 同 model 历史回放时 transformMessages 会丢弃这些块, 不会 400
            const reasoning = extractReasoningDelta(delta);
            if (reasoning) {
                thinkingOpen = true;
                yield { type: 'thinking_delta', text: reasoning };
            }

            const hasText = typeof delta.content === 'string' && delta.content.length > 0;
            // 空 tool_calls 数组 (部分 OpenAI 兼容网关在思考阶段持续发 "tool_calls": []) 不算工具调用
            // — 否则会提前关闭思考, 并让 stopReason 误报 tool_use
            const toolCallDeltas = delta.tool_calls?.length ? delta.tool_calls : undefined;
            if (thinkingOpen && (hasText || toolCallDeltas)) {
                thinkingOpen = false;
                yield { type: 'thinking_done' };
            }

            if (hasText) {
                yield { type: 'text_delta', text: delta.content as string };
            }

            if (toolCallDeltas) {
                sawToolCalls = true;
                for (const tc of toolCallDeltas) {
                    const existing = toolCalls.get(tc.index) ?? { id: '', name: '', args: '' };
                    const next = {
                        id: tc.id ?? existing.id,
                        name: tc.function?.name ?? existing.name,
                        args: existing.args + (tc.function?.arguments ?? ''),
                    };

                    const shouldStart = !existing.id && !!next.id && !!next.name;
                    toolCalls.set(tc.index, next);

                    if (shouldStart) {
                        yield { type: 'tool_use_start', id: next.id, name: next.name };
                    }

                    if (tc.function?.arguments) {
                        yield {
                            type: 'tool_use_delta',
                            id: next.id,
                            input: tc.function.arguments,
                        };
                    }
                }
            }

            if (choice?.finish_reason === 'tool_calls') {
                for (const [, toolCall] of toolCalls) {
                    if (toolCall.id) {
                        yield { type: 'tool_use_done', id: toolCall.id, arguments: toolCall.args || undefined };
                    }
                }
            }
        }

        if (thinkingOpen) {
            yield { type: 'thinking_done' };
        }

        yield {
            type: 'done',
            stopReason: sawToolCalls ? 'tool_use' : 'end_turn',
            usage: usage ?? { inputTokens: 0, outputTokens: 0 },
        };
    }
}

/**
 * 从 chat chunk delta 中取推理增量。
 * OpenAI SDK 类型未声明这两个字段, DeepSeek/Qwen 用 reasoning_content, OpenRouter 用 reasoning。
 */
function extractReasoningDelta(delta: ChatCompletionChunk['choices'][number]['delta']): string | null {
    const record = delta as unknown as Record<string, unknown>;
    for (const key of ['reasoning_content', 'reasoning'] as const) {
        const value = record[key];
        if (typeof value === 'string' && value.length > 0) {
            return value;
        }
    }
    return null;
}
