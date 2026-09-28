import type {AgentMessage} from "../types.ts";
import type {
    SessionMessageEntry,
    SessionMetadata,
    CompactionInput, SessionCompactionEntry, SessionEntry
} from "./types.ts";


export interface SessionStore {

    /**
     * 获取当前 Session 的基础信息。
     */
    getMetadata(): Promise<SessionMetadata>;


    /**
     * 保存一条完整消息。
     *
     * id、seq、timestamp 由存储实现生成，
     * 调用方只负责传入 AgentMessage。
     */
    appendMessage(
        message: AgentMessage,
    ): Promise<SessionMessageEntry>;


    /**
     * 按 seq 从小到大读取全部 Entry，包括原消息和压缩记录。
     */
    getEntries(): Promise<SessionEntry[]>;


    /**
     * 读取所有原始消息，用于查看历史，不应用压缩。
     * 恢复 Agent 上下文应使用 buildAgentContext(await store.getEntries())。
     */
    getMessages(): Promise<AgentMessage[]>;


    /** 追加摘要和保留边界；不删除或覆盖原消息。 */
    appendCompaction(input: CompactionInput): Promise<SessionCompactionEntry>;

    /** 模型调用前检查存储格式是否支持压缩；v1 会话会拒绝。 */
    assertCanCompact(): void;

}
