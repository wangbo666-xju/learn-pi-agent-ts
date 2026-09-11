import type {
    AgentMessage,
    AssistantMessage,
    LlmClient,
    LlmRequestOptions,
    LlmStreamListener,
    Tool,
    ToolArguments,
} from "./types.ts";
import {TextDecoder} from "node:util";

/** OpenAI 兼容接口中，非流式 tool_calls 的传输结构。 */
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

/** SSE 每个 data 帧解析后的最小结构，只声明本项目实际使用的字段。 */
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


/**
 * OpenAI 兼容模型适配器。
 *
 * 对上层暴露统一的 AgentMessage / Tool / LlmStreamEvent；
 * 对下层负责 HTTP 请求、OpenAI 消息格式和 SSE 工具参数碎片的转换。
 */
export class RealLlmClient implements LlmClient {

    /** 普通非流式请求：等待服务端一次性返回完整 assistant 消息。 */
    async chat(messages: AgentMessage[], tools: Tool[], options?: LlmRequestOptions,): Promise<AssistantMessage> {
        const {apiKey, baseUrl, model} = requireConfig();
        const apiMessages = toApiMessages(
            messages,
            options?.systemPrompt,
        );
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
            signal: options?.signal,
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


    /**
     * 流式请求：把底层 SSE chunk 转成 start/text_delta/toolcall_delta/done。
     * 此处绝不打印终端；CLI 通过订阅 AgentEvent 决定如何展示。
     */
    async chatStream(messages: AgentMessage[], tools: Tool[], onEvent: LlmStreamListener,
                     options?: LlmRequestOptions,): Promise<AssistantMessage> {

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
                messages: toApiMessages(
                    messages,
                    options?.systemPrompt,
                ), tools: toApiTools(tools),
                tool_choice: "auto"

            }),
            signal: options?.signal,
        });
        if (!response.ok) {
            throw new Error(`模型请求失败：${response.status} ${await response.text()}`);
        }

        // content 保存当前完整文本快照；每个 text_delta 都带上累积后的值。
        let content = "";

        // 即使模型还没有输出文本，也先让上层进入“assistant 正在生成”的状态。
        await onEvent({
            type: "start",
            partial: {role: "assistant", content: ""},
        });

        // OpenAI 将同一工具调用拆成多个 SSE chunk；按 index 分组后逐段累加。
        const toolCallFragments = new Map<number, { id: string; name: string; argumentsText: string }>();

        await readSseChunks(response, async (chunk) => {
            const delta = chunk.choices[0]?.delta;
            if (!delta) {
                return;
            }

            if (delta.content) {
                content += delta.content;
                await onEvent({
                    type: "text_delta",
                    delta: delta.content,
                    partial: {role: "assistant", content},
                });
            }

            let hasToolFragment = false;

            for (const fragment of delta.tool_calls ?? []) {
                const index = fragment.index ?? 0;
                let current = toolCallFragments.get(index);
                if (!current) {
                    current = {
                        id: fragment.id ?? "",
                        name: fragment.function?.name ?? "",
                        argumentsText: ""
                    };
                    toolCallFragments.set(index, current);
                }
                if (fragment.id) current.id = fragment.id;
                if (fragment.function?.name) current.name = fragment.function.name;
                if (fragment.function?.arguments) {
                    current.argumentsText += fragment.function.arguments;
                }

                hasToolFragment = true;
            }

            if (hasToolFragment) {
                await onEvent({
                    type: "toolcall_delta",
                    partial: {role: "assistant", content},
                });
            }

        });

        // 只有流结束时 argumentsText 才应是完整 JSON；此时才允许解析和执行工具。
        // 按 index 排序，保证多工具调用的顺序和模型输出一致。
        const toolCalls = [...toolCallFragments.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, {id, name, argumentsText}]) => ({
                id,
                name,
                arguments: argumentsText ? parseToolArguments(argumentsText) : {},
            }));

        const message: AssistantMessage = {
            role: "assistant",
            content,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        };

        // done 携带可直接进入 Agent Loop 的完整 assistant 消息。
        await onEvent({type: "done", message});

        return message;
    }


}


/** 将模型返回的 JSON 字符串限制为对象，拒绝数组、null 和基础类型。 */
function parseToolArguments(text: string): ToolArguments {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("模型返回的工具参数不是对象");
    }
    return value as ToolArguments;

}

/** 读取运行时模型配置，缺任一项就尽早失败。 */
function requireConfig() {
    const apiKey = process.env.OPENAI_API_KEY;
    const baseUrl = process.env.OPENAI_BASE_URL;
    const model = process.env.OPENAI_MODEL;
    if (!apiKey || !baseUrl || !model) {
        throw new Error("缺少 OPENAI_API_KEY、OPENAI_BASE_URL 或 OPENAI_MODEL");
    }
    return {apiKey, baseUrl, model};
}

function toApiMessages(
    messages: AgentMessage[],
    systemPrompt?: string,
) {
    // 应用层 toolResult 需转换成 OpenAI 的 role: "tool" + tool_call_id 格式。
    const apiMessages = messages.map((message) => {
        if (message.role === "toolResult") {
            return {
                role: "tool",
                tool_call_id: message.toolCallId,
                content: message.content,
            };
        }

        if (message.role === "assistant" && message.toolCalls?.length) {
            return {
                role: "assistant",
                content: message.content || null,
                tool_calls: message.toolCalls.map((toolCall) => ({
                    id: toolCall.id,
                    type: "function",
                    function: {
                        name: toolCall.name,
                        arguments: JSON.stringify(toolCall.arguments),
                    },
                })),
            };
        }

        return {
            role: message.role,
            content: message.content,
        };
    });

    return systemPrompt
        ? [
            {
                role: "system",
                content: systemPrompt,
            },
            ...apiMessages,
        ]
        : apiMessages;
}


function toApiTools(tools: Tool[]) {
    // Tool 是 Agent 的统一描述；这里仅适配为 OpenAI function calling 的 payload。
    return tools.map((tool) => ({
        type: "function",
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        },
    }));
}

async function readSseChunks(
    response: Response,
    onChunk: (chunk: StreamChunk) => void | Promise<void>,
): Promise<void> {
    if (!response.body) {
        throw new Error("模型响应没有流内容");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    // 网络 chunk 不等于 SSE 行：用 buffer 留住被截断的最后一行，等下一次读取拼接。
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

            // 等待上层处理完当前事件，保证事件顺序不会被异步监听器打乱。
            await onChunk(JSON.parse(payload) as StreamChunk);
        }

        if (done) {
            return;
        }
    }

}

