//------------------------message
export type UserMessage = {
    role: "user";
    content: string;
};

export type AssistantMessage = {
    role: "assistant";
    content: string;
    toolCalls?: ToolCall[];
};

export type ToolResultMessage = {
    role: "toolResult";
    toolCallId: string;
    content: string;
    isError: boolean;
    details?: unknown;
};

export type ToolExecutionResult = {
    content: string;
    details?: unknown;
    terminate?: boolean;
};


export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage;

//------------------------llm
export interface LlmClient {
    chat(
        messages: AgentMessage[],
        tools: Tool[],
        options?: LlmRequestOptions,
    ): Promise<AssistantMessage>;

    chatStream(
        messages: AgentMessage[],
        tools: Tool[],
        onEvent: LlmStreamListener,
        options?: LlmRequestOptions,
    ): Promise<AssistantMessage>;
}

export type LlmRequestOptions = {
    systemPrompt?: string;
    signal?: AbortSignal;
};


export type LlmStreamEvent =
    | {
    type: "start";
    partial: AssistantMessage;
}
    | {
    type: "text_delta";
    delta: string;
    partial: AssistantMessage;
}
    | {
    type: "toolcall_delta";
    partial: AssistantMessage;
}
    | {
    type: "done";
    message: AssistantMessage;
};

export type LlmStreamListener = (
    event: LlmStreamEvent,
) => void | Promise<void>;



//------------------------tool

export interface Tool {
    name: string;
    description: string;
    parameters: Record<string, unknown>;

    execute(
        args: ToolArguments,
        signal?: AbortSignal,
        onUpdate?: ToolUpdateCallback,
    ): Promise<ToolExecutionResult>;
}

export type ToolArguments = Record<string, unknown>;

export type ToolCall = {
    id: string;
    name: string;
    arguments: ToolArguments;
};
export type ToolUpdateCallback = (
    partialResult: ToolExecutionResult,
) => void | Promise<void>;


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
    terminate?: boolean;
};

export type BeforeToolCall = (
    toolCall: ToolCall,
    signal?: AbortSignal,
) => Promise<BeforeToolCallResult | undefined>;

export type AfterToolCall = (
    input: {
        toolCall: ToolCall;
        result: ToolExecutionResult;
        isError: boolean;
    },
    signal?: AbortSignal,
) => Promise<{
    result?: ToolExecutionResult;
    isError?: boolean;
} | undefined>;