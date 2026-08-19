import type {AgentMessage, AssistantMessage, LlmClient, Tool, ToolArguments} from "./types.ts";


type ApiToolCall = {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string;
    };

}


type ChatCompletionResponse = {
    choices: Array<{
        message: {
            content: string | null;
            tool_calls?: ApiToolCall[];
        };
    }>;
};

type StreamChunk = {
    choices: Array<{
        delta: {
            content?: string;
        };
    }>;
};


function parseToolArguments(text: string): ToolArguments {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("模型返回的工具参数不是对象");
    }
    return value as ToolArguments;

}

export class RealLlmClient implements LlmClient {
    async chat(messages: AgentMessage[], tools: Tool[]): Promise<AssistantMessage> {
        const apiKey = process.env.OPENAI_API_KEY;
        const baseUrl = process.env.OPENAI_BASE_URL;
        const model = process.env.OPENAI_MODEL;

        if (!apiKey || !baseUrl || !model) {
            throw new Error("缺少 OPENAI_API_KEY、OPENAI_BASE_URL 或 OPENAI_MODEL");
        }

        const apiMessages = messages.map((message) => {
            if (message.role === "toolResult") {
                return {
                    role: "tool",
                    tool_call_id: message.toolCallId,
                    content: message.content,
                }
            }

            if (message.role === "assistant" && message.toolCalls?.length) {
                return {
                    role: "assistant",
                    content: message.content || null,
                    tool_calls: message.toolCalls.map((toolCall => ({
                        id: toolCall.id,
                        type: "function",
                        function: {
                            name: toolCall.name,
                            arguments: JSON.stringify(toolCall.arguments),

                        }

                    })))
                }
            }

            return {
                role: message.role,
                content: message.content
            }

        })


        const response = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model,
                messages: apiMessages,
                tools: tools.map((tool) => ({
                    type: "function",
                    function: {
                        name: tool.name,
                        description: tool.description,
                        parameters: tool.parameters,
                    },
                })),
                tool_choice: "auto",
            }),
        });

        if (!response.ok) {
            throw new Error(`模型请求失败：${response.status} ${await response.text()}`);
        }

        const data = (await response.json()) as ChatCompletionResponse;
        const message = data.choices[0]?.message;
        if (!message) {
            throw new Error("模型没有返回 message");
        }
        return {
            role: "assistant",
            content: message.content ?? "",
            toolCalls: message.tool_calls?.map((toolCall) => ({
                id: toolCall.id,
                name: toolCall.function.name,
                arguments: parseToolArguments(toolCall.function.arguments)
            }))
        };
    }


    async streamText(prompt: string): Promise<void> {
        const apiKey = process.env.OPENAI_API_KEY;
        const baseUrl = process.env.OPENAI_BASE_URL;
        const model = process.env.OPENAI_MODEL;

        if (!apiKey || !baseUrl || !model) {
            throw new Error("缺少模型配置");
        }

        const response = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model,
                stream: true,
                messages: [
                    {
                        role: "user",
                        content: prompt,
                    },
                ],
            }),
        });

        if (!response.ok) {
            throw new Error(`模型请求失败：${response.status} ${await response.text()}`);
        }

        if (!response.body) {
            throw new Error("模型响应没有流内容");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        let buffer = "";

        while (true) {
            const {value, done} = await reader.read();

            buffer += decoder.decode(value, {stream: !done});

            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const rawLine of lines) {
                const line = rawLine.trim();

                if (!line.startsWith("data:")) {
                    continue;
                }

                const payload = line.slice(5).trim();

                if (payload === "[DONE]") {
                    return;
                }

                const chunk = JSON.parse(payload) as StreamChunk;
                const text = chunk.choices[0]?.delta.content;

                if (text) {
                    process.stdout.write(text);
                }
            }

            if (done) {
                return;
            }
        }
    }
}