import type { AgentMessage, AssistantMessage, LlmClient } from "./types.ts";

export class FakeLlmClient implements LlmClient {
    async chat(messages: AgentMessage[]): Promise<AssistantMessage> {
        const hasToolResult = messages.some((message) => message.role === "toolResult");

        if (!hasToolResult) {
            return {
                role: "assistant",
                content: "我需要先读取文件。",
                toolCalls: [
                    {
                        id: "call_1",
                        name: "read",
                        arguments: { path: "README.md" },
                    },
                ],
            };
        }

        const result = messages.find((message) => message.role === "toolResult");

        return {
            role: "assistant",
            content: `文件内容是：${result?.content}`,
        };
    }
}