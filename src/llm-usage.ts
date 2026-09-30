import type {TokenUsage} from "./types.ts";

/** prompt_tokens 已包含缓存命中数；拆分后相加必须仍等于原输入用量。 */
export function normalizeUsage(raw: unknown): TokenUsage | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const value = raw as Record<string, unknown>;
    const details = value.prompt_tokens_details as {cached_tokens?: unknown} | undefined;
    const input = value.prompt_tokens;
    const output = value.completion_tokens;
    const cacheRead = details?.cached_tokens ?? value.prompt_cache_hit_tokens ?? 0;
    if (![input, output, cacheRead].every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)) return undefined;
    // 上面的运行时检查不负责 TypeScript 的变量收窄。
    if (typeof input !== "number" || typeof output !== "number" || typeof cacheRead !== "number") return undefined;
    if (cacheRead > input || !Number.isSafeInteger(input + output)) return undefined;
    return {input: input - cacheRead, output, cacheRead, cacheWrite: 0, totalTokens: input + output};
}

/** 只有适配器确认的上下文溢出，Session 才能进行一次压缩恢复。 */
export class ContextOverflowError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ContextOverflowError";
    }
}

export function createLlmHttpError(status: number, body: string): Error {
    let code: unknown;
    let detail: unknown;
    try {
        const data = JSON.parse(body) as {error?: {code?: unknown; message?: unknown}};
        code = data?.error?.code;
        detail = data?.error?.message;
    } catch { /* 非 JSON 错误保留原始诊断，不猜测错误类别。 */ }
    const message = `模型请求失败：${status} ${body}`;
    return (status === 400 || status === 413)
        && (code === "context_length_exceeded" || code === "context_window_exceeded"
            || (typeof detail === "string" && /maximum context length is [\d,]+ tokens.*(?:requested|resulted)/is.test(detail)))
        ? new ContextOverflowError(message) : new Error(message);
}
