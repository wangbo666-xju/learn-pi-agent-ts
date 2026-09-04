import type {
    AgentMessage,
    AssistantMessage,
    Tool,
} from "./types.ts";

/**
 * Agent 在当前进程中的实时状态。
 *
 * Session 负责跨进程持久化；AgentState 负责描述当前正在运行什么。
 */
export type AgentState = {
    /** 每次请求模型时可以使用的完整上下文。 */
    messages: AgentMessage[];

    /** 当前系统提示词，包括 Skill 索引。 */
    systemPrompt: string;

    /** 当前允许模型调用的工具。 */
    tools: Tool[];

    /** 从 agent_start 到 agent_end 之间为 true。 */
    isRunning: boolean;

    /** SSE 期间正在不断被完整快照替换的 assistant 消息。 */
    streamingMessage?: AssistantMessage;

    /** 当前正在执行的工具调用 ID。 */
    pendingToolCalls: ReadonlySet<string>;

    /** 本轮模型或运行时错误；下一次正常运行开始时清空。 */
    errorMessage?: string;
};


export type CreateAgentStateInput = {
    messages?: AgentMessage[];
    systemPrompt?: string;
    tools?: Tool[];
};


/**
 * 创建 Agent 初始状态。
 *
 * 这里只复制顶层数组：Agent 可以追加或替换数组元素，
 * 但不会因为调用者继续 push 原数组而被意外修改。
 */
export function createAgentState(
    input: CreateAgentStateInput = {},
): AgentState {
    return {
        messages: [...(input.messages ?? [])],
        systemPrompt: input.systemPrompt ?? "",
        tools: [...(input.tools ?? [])],
        isRunning: false,
        pendingToolCalls: new Set<string>(),
    };
}