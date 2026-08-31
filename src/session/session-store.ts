import type {AgentMessage} from "../types.ts";
import type {
    SessionMessageEntry,
    SessionMetadata,
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
     * 按 seq 从小到大读取全部消息 Entry。
     */
    getEntries(): Promise<SessionMessageEntry[]>;


    /**
     * 读取可以直接恢复到 Agent Context 的消息。
     */
    getMessages(): Promise<AgentMessage[]>;

}