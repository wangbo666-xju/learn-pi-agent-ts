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

export type ToolResultMessage = {
    role: "toolResult";
    toolCallId: string;
    content: string;
};

export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage;

export interface LlmClient {
    chat(messages: AgentMessage[], tools: Tool[]): Promise<AssistantMessage>;

    chatStream(messages: AgentMessage[], tools: Tool[], onText: (text: string) => void): Promise<AssistantMessage>;
}

export interface Tool {
    name: string;
    description: string;
    parameters: Record<string, unknown>;

    execute(args: ToolArguments): Promise<string>;
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