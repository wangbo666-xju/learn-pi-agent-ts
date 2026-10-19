//------------------------message
export type UserMessage = {
    role: "user";
    content: string;
    /** 应用记录 Skill 来源；提取记忆时只采用用户附加要求，不采用 Skill 正文。 */
    source?: { kind: "skill"; name: string; additionalInstructions?: string };
};

export type AssistantMessage = {
    role: "assistant";
    content: string;
    toolCalls?: ToolCall[];
    /** 本次请求的实际用量；不是全会话累计费用。 */
    usage?: TokenUsage;
    /** 模型、服务地址、系统提示及工具定义的指纹，避免配置变化后使用旧用量。 */
    usageContextKey?: string;
};

export type TokenUsage = {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
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
    getUsageContextKey?(tools: Tool[], options?: LlmRequestOptions): string;

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
    maxOutputTokens?: number;
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
