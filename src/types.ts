export type ToolArguments = Record<string, unknown>;

export type ToolCall = {
    id: string;
    name: string;
    arguments: ToolArguments;
};

export type UserMessage = {
    role: "user";
    content: string;
};

export type AssistantMessage = {
    role: "assistant";
    content: string;
    toolCalls?: ToolCall[];
};

export type ToolExecutionResult = {
    content: string;
    details?: unknown;
    terminate?: boolean;
};

export type ToolResultMessage = {
    role: "toolResult";
    toolCallId: string;
    content: string;
    isError: boolean;
    details?: unknown;
};

export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage;

export interface LlmClient {
    chat(
        messages: AgentMessage[],
        tools: Tool[],
        options?: LlmRequestOptions,
    ): Promise<AssistantMessage>;

    chatStream(
        messages: AgentMessage[],
        tools: Tool[],
        onText: (text: string) => void,
        options?: LlmRequestOptions,
    ): Promise<AssistantMessage>;
}

export type LlmRequestOptions = {
    systemPrompt?: string;
};

export interface Tool {
    name: string;
    description: string;
    parameters: Record<string, unknown>;

    execute(args: ToolArguments): Promise<ToolExecutionResult>;
}

export type ToolRunContext = {
    id: string;                       // 对应 toolCall.id
    name: string;                     // 工具名
    state: "running" | "done" | "error";
    startedAt: number;
    finishedAt?: number;
    input: ToolArguments;
    output?: string;
    error?: string;
};

export type BeforeToolCallResult = {

    block: boolean;
    reason?: string;

}
export type BeforeToolCall = (
    toolCall: ToolCall,
) => Promise<BeforeToolCallResult | undefined>;

