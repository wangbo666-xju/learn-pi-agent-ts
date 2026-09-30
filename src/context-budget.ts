import type {SessionEntry} from "./session/types.ts";

export type AutoCompactOptions = {
    /** 应用采用的上下文窗口，不能大于实际模型支持的窗口。 */
    contextWindowTokens: number;
    /** 提前触发的余量，不等于强制设置模型 max_tokens。 */
    reserveTokens: number;
};

export function validateAutoCompact(options: AutoCompactOptions): void {
    if (!Number.isSafeInteger(options.contextWindowTokens) || options.contextWindowTokens <= 0
        || !Number.isSafeInteger(options.reserveTokens) || options.reserveTokens <= 0
        || options.reserveTokens >= options.contextWindowTokens) {
        throw new Error("自动压缩预算无效：窗口和预留必须为正整数，且预留小于窗口");
    }
}

/**
 * 上次完整请求的真实用量已经涵盖 system、Skill 索引、tools 与当时的 messages。
 * 这里只额外估算其后新增消息。使用 UTF-8 字节数作保守增量，不宣称精确 Token。
 * 没有可用 usage 时返回 undefined，不把猜测冒充实际用量。
 */
export function estimateContextTokens(entries: SessionEntry[], contextKey?: string): number | undefined {
    let trailing = 0;
    for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index]!;
        // 即使旧消息仍保留，其 usage 描述的也是压缩前的请求，不得跨过此边界。
        if (entry.type === "compaction") break;
        const message = entry.message;
        if (message.role === "assistant" && message.usageContextKey === contextKey && message.usage) {
            const {input, output, cacheRead, cacheWrite, totalTokens} = message.usage;
            if ([input, output, cacheRead, cacheWrite, totalTokens].every((n) => Number.isSafeInteger(n) && n >= 0)
                && totalTokens > 0 && totalTokens === input + output + cacheRead + cacheWrite) {
                return totalTokens + trailing;
            }
        }
        // details、usage 等本地元数据不会发给模型，不纳入增量。
        const projected = message.role === "assistant"
            ? {role: message.role, content: message.content, toolCalls: message.toolCalls}
            : message.role === "toolResult"
                ? {role: message.role, content: message.content, toolCallId: message.toolCallId}
                : message;
        trailing += Buffer.byteLength(JSON.stringify(projected), "utf8");
    }
    return undefined;
}
