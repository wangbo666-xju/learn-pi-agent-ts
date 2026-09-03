import type {
    AgentMessage,
    AssistantMessage,
    ToolArguments,
    ToolExecutionResult,
    ToolResultMessage,
} from "./types.ts";


export type AgentStopReason =
    | "completed"
    | "aborted"
    | "max_turns"
    | "terminated"
    | "error";


/** 模型流式生成 assistant 消息时的一次增量。 */
export type AssistantMessageUpdate =
    | {
    type: "text_delta";
    delta: string;
}
    | {
    type: "toolcall_delta";
};


/**
 * Agent 对外发布的生命周期事件。
 *
 * message_update 携带的是当前完整 partial 快照，
 * update 只描述本次发生的增量类型。
 */
export type AgentEvent =
    | {
    type: "agent_start";
}
    | {
    type: "agent_end";
    reason: AgentStopReason;
    newMessages: AgentMessage[];
}
    | {
    type: "turn_start";
    turn: number;
}
    | {
    type: "turn_end";
    turn: number;
    message: AssistantMessage;
    toolResults: ToolResultMessage[];
}
    | {
    type: "message_start";
    message: AgentMessage;
}
    | {
    type: "message_update";
    message: AssistantMessage;
    update: AssistantMessageUpdate;
}
    | {
    type: "message_end";
    message: AgentMessage;
}
    | {
    type: "tool_execution_start";
    toolCallId: string;
    toolName: string;
    args: ToolArguments;
}
    | {
    type: "tool_execution_update";
    toolCallId: string;
    toolName: string;
    partialResult: ToolExecutionResult;
}
    | {
    type: "tool_execution_end";
    toolCallId: string;
    toolName: string;
    result: ToolExecutionResult;
    isError: boolean;
};


export type AgentEventListener = (
    event: AgentEvent,
) => void | Promise<void>;


/**
 * Agent 内部使用的最小事件总线。
 *
 * 监听器按照注册顺序执行，并逐个等待完成。
 * Session 监听器因此可以在 message_end 阶段完成落盘。
 */
export class AgentEventBus {
    private readonly listeners = new Set<AgentEventListener>();

    /** 注册监听器，返回取消订阅函数。 */
    subscribe(listener: AgentEventListener): () => void {
        this.listeners.add(listener);

        return () => {
            this.listeners.delete(listener);
        };
    }

    /** 按照注册顺序发布并等待所有监听器。 */
    async emit(event: AgentEvent): Promise<void> {
        for (const listener of this.listeners) {
            await listener(event);
        }
    }
}