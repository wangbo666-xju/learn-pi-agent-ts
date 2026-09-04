import type {
    AgentMessage,
    AssistantMessage,
    LlmClient, LlmStreamListener,
    Tool,
} from "./types.ts";

export type FakeLlmRequest = {
    messages: AgentMessage[];
    toolNames: string[];
};

/**
 * 按构造时给定的顺序返回预设回复，用于在不调用真实模型的情况下调试 Agent Loop。
 */
export class FakeLlmClient implements LlmClient {
    readonly requests: FakeLlmRequest[] = [];
    private readonly responses: AssistantMessage[];

    constructor(responses: AssistantMessage[]) {
        this.responses = structuredClone(responses);
    }

    async chat(messages: AgentMessage[], tools: Tool[]): Promise<AssistantMessage> {
        this.requests.push({
            messages: structuredClone(messages),
            toolNames: tools.map((tool) => tool.name),
        });

        const response = this.responses.shift();
        if (!response) {
            throw new Error("Fake LLM 没有更多预设回复");
        }

        return structuredClone(response);
    }

    async chatStream(
        messages: AgentMessage[],
        tools: Tool[],
        onEvent: LlmStreamListener,
    ): Promise<AssistantMessage> {
        const response = await this.chat(messages, tools);
        await onEvent({
            type: "start",
            partial: {role: "assistant", content: ""},
        });

        if (response.content) {
            await onEvent({
                type: "text_delta",
                delta: response.content,
                partial: {role: "assistant", content: response.content},
            });
        }
        if (response.toolCalls?.length) {
            await onEvent({
                type: "toolcall_delta",
                partial: {role: "assistant", content: response.content},
            });
        }

        await onEvent({type: "done", message: structuredClone(response)});

        return response;
    }
}
