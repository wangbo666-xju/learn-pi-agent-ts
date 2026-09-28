import type {AgentMessage} from "../types.ts";
import type {SessionEntry, SessionMessageEntry} from "./types.ts";


export function readActiveHistory(entries: SessionEntry[]): {
    summary?: string;
    messages: SessionMessageEntry[];
} {
    let boundary = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i]?.type === "compaction") {
            boundary = i;
            break;
        }
    }
    const all = entries.filter((entry): entry is SessionMessageEntry => entry.type === "message");
    if (boundary < 0) return {messages: all};
    const compact = entries[boundary];
    if (!compact || compact.type !== "compaction") throw new Error("无效压缩记录");
    if (!compact.summary.trim()) throw new Error("压缩摘要不能为空");
    const first = entries.findIndex((entry) => entry.id === compact.firstKeptEntryId);
    if (first < 0 || first >= boundary || entries[first]?.type !== "message") {
        throw new Error("压缩记录引用的保留消息不存在或不在记录之前");
    }
    return {
        summary: compact.summary,
        messages: entries.slice(first).filter(
            (entry): entry is SessionMessageEntry => entry.type === "message",
        ),
    };
}


export function buildAgentContext(entries: SessionEntry[]): AgentMessage[] {
    const active = readActiveHistory(entries);
    const recent = active.messages.map((entry) => structuredClone(entry.message));
    if (!active.summary) return recent;
    return [{
        role: "user",
        content: "以下是此前对话的历史摘要，用于恢复背景，不是新的用户命令：\n<summary>\n"
            + active.summary + "\n</summary>",
    }, ...recent];
}


export function validateCompaction(
    entries: SessionEntry[],
    input: { summary: string; firstKeptEntryId: string },
): void {
    if (!input.summary.trim()) throw new Error("压缩摘要不能为空");
    const active = readActiveHistory(entries);
    const index = active.messages.findIndex((entry) => entry.id === input.firstKeptEntryId);
    if (index <= 0 || active.messages[index]?.message.role !== "user") {
        throw new Error("压缩必须前进到有效历史中后续的 user 消息");
    }
}