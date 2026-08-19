import type { AgentMessage, AssistantMessage, LlmClient } from "./types.ts";

type ChatCompletionResponse = {
    choices: Array<{
        message: {
            content: string | null;
        };
    }>;
};

export class RealLlmClient implements LlmClient {
    async chat(messages: AgentMessage[]): Promise<AssistantMessage> {
        const apiKey = process.env.OPENAI_API_KEY;
        const baseUrl = process.env.OPENAI_BASE_URL;
        const model = process.env.OPENAI_MODEL;

        if (!apiKey || !baseUrl || !model) {
            throw new Error("缺少 OPENAI_API_KEY、OPENAI_BASE_URL 或 OPENAI_MODEL");
        }

        // 当前阶段只验证普通对话；下一步才把 toolCall / toolResult 转为 API 工具协议。
        const apiMessages = messages
            .filter((message) => message.role !== "toolResult")
            .map((message) => ({
                role: message.role,
                content: message.content,
            }));

        const response = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model,
                messages: apiMessages,
            }),
        });

        if (!response.ok) {
            throw new Error(`模型请求失败：${response.status} ${await response.text()}`);
        }

        const data = (await response.json()) as ChatCompletionResponse;

        return {
            role: "assistant",
            content: data.choices[0]?.message.content ?? "",
        };
    }
}