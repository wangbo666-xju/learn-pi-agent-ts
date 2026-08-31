import {AgentMessage} from "../types.ts";


/**
 * 当前 Session 文件格式版本。
 * 后续修改落盘结构时，需要增加版本号并考虑旧数据迁移。
 */
export const CURRENT_SESSION_VERSION = 1;


/**
 * Session 的基础信息。
 */
export type SessionMetadata = {
    id: string;
    createdAt: number;
};


/**
 * JSONL 文件的第一行。
 * 它描述整个 Session，而不是一条对话消息。
 */
export type SessionHeader = SessionMetadata & {
    type: "session";
    version: typeof CURRENT_SESSION_VERSION;
};

/**
 * 一条已经持久化的 Agent 消息。
 *
 * 第一版先做线性历史，因此暂时没有 parentId、Lane 和分支。
 */
export type SessionMessageEntry = {
    type: "message";
    id: string;

    /**
     * Session 内从 1 开始递增的序号。
     * 后续读取 JSONL 时可以用它检查消息顺序。
     */
    seq: number;

    timestamp: number;
    message: AgentMessage;
};

/**
 * JSONL 文件中可能出现的数据类型。
 */
export type SessionFileItem = SessionHeader | SessionMessageEntry;