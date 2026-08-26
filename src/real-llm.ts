import type {AgentMessage, AssistantMessage, LlmClient, Tool, ToolArguments} from "./types.ts";
import {TextDecoder} from "node:util";


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
            tool_calls?: Array<{
                index?: number;      // 第几个工具调用（多个工具时区分）
                id?: string;
                type?: string;
                function?: {
                    name?: string;
                    arguments?: string;   // JSON 字符串碎片！
                };
            }>
        };
        finish_reason?: string | null;
    }>;
};


export class RealLlmClient implements LlmClient {

    async chat(messages: AgentMessage[], tools: Tool[]): Promise<AssistantMessage> {
        const {apiKey, baseUrl, model} = requireConfig();
        const apiMessages = toApiMessages(messages);

        const response = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model,
                messages: apiMessages,
                tools: toApiTools(tools),
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
        const {apiKey, baseUrl, model} = requireConfig();


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
        await readSseChunks(response, (chunk) => {
            const text = chunk.choices[0]?.delta.content;
            if (text) process.stdout.write(text);
        });

    }

    async chatStream(messages: AgentMessage[], tools: Tool[], onText: (text: string) => void): Promise<AssistantMessage> {

        const {apiKey, baseUrl, model} = requireConfig();


        const response = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model,
                stream: true,//流式
                messages: toApiMessages(messages),
                tools: toApiTools(tools),
                tool_choice: "auto"

            }),
        });
        if (!response.ok) {
            throw new Error(`模型请求失败：${response.status} ${await response.text()}`);
        }

        let content = "";

        // 按 index 分组累加工具调用碎片
        const toolCallFragments = new Map<number, { id: string; name: string; argumentsText: string }>();

        await readSseChunks(response, (chunk) => {
            let delta = chunk.choices[0]?.delta;
            if (!delta) {
                return;
            }
            if (delta.content) {
                content += delta.content;
                onText(delta.content);
            }

            for (const fragment of delta.tool_calls ?? []) {
                const index = fragment.index ?? 0;
                let acc = toolCallFragments.get(index);
                if (!acc) {
                    acc = {id: fragment.id ?? "", name: fragment.function?.name ?? "", argumentsText: ""};
                    toolCallFragments.set(index, acc);
                }
                if (fragment.id) acc.id = fragment.id;
                if (fragment.function?.name) acc.name = fragment.function.name;
                if (fragment.function?.arguments) acc.argumentsText += fragment.function.arguments;


            }
        });

        // 流结束：按 index 排序组装，与非流式 chat() 结构一致
        const toolCalls = [...toolCallFragments.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, {id, name, argumentsText}]) => ({
                id,
                name,
                arguments: argumentsText ? parseToolArguments(argumentsText) : {},
            }));

        return {
            role: "assistant",
            content,
            toolCalls: toolCalls.length ? toolCalls : undefined,
        };
    }


}


function parseToolArguments(text: string): ToolArguments {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("模型返回的工具参数不是对象");
    }
    return value as ToolArguments;

}

function requireConfig() {
    const apiKey = process.env.OPENAI_API_KEY;
    const baseUrl = process.env.OPENAI_BASE_URL;
    const model = process.env.OPENAI_MODEL;
    if (!apiKey || !baseUrl || !model) {
        throw new Error("缺少 OPENAI_API_KEY、OPENAI_BASE_URL 或 OPENAI_MODEL");
    }
    return {apiKey, baseUrl, model};
}

function toApiMessages(messages: AgentMessage[]) {
    return messages.map((message) => {
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

}


function toApiTools(tools: Tool[]) {

    return tools.map((tool) => ({
        type: "function",
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        },
    }));
}

async function readSseChunks(response: Response, onChunk: (chunk: StreamChunk) => void) {
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

            onChunk(JSON.parse(payload) as StreamChunk);

        }

        if (done) {
            return;
        }
    }

}

