# Task 2A：模型语义流 Implementation Plan

**Goal:** 把 `chatStream` 的裸文本回调升级为 `start/text_delta/toolcall_delta/done` 语义事件，同时保持当前输出和工具调用行为不变。

**Architecture:** `RealLlmClient` 负责把 OpenAI 兼容 SSE 累积为不可变 partial 快照；它不负责 UI。`FakeLlmClient` 实现同一协议，`Agent` 在本阶段临时只消费 `text_delta` 来维持终端输出。

**Spec:** `docs/PI_AGENT_LEARNING_DESIGN.md`

## 修改范围

```text
src/types.ts
src/real-llm.ts
src/fake-llm.ts
src/agent.ts
test/real-llm.test.ts
```

## Step 1：先写失败测试

在 `test/real-llm.test.ts` 增加：

```ts
import type {LlmStreamEvent} from "../src/types.ts";

test("chatStream 按顺序发出模型语义事件", async () => {
    const originalFetch = globalThis.fetch;
    const originalApiKey = process.env.OPENAI_API_KEY;
    const originalBaseUrl = process.env.OPENAI_BASE_URL;
    const originalModel = process.env.OPENAI_MODEL;

    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_BASE_URL = "https://example.test";
    process.env.OPENAI_MODEL = "test-model";

    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(encoder.encode(
                'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
            ));
            controller.enqueue(encoder.encode(
                'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
            ));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
        },
    });

    globalThis.fetch = async () => new Response(body, {status: 200});

    try {
        const events: LlmStreamEvent[] = [];
        const client = new RealLlmClient();
        const result = await client.chatStream(
            [{role: "user", content: "hi"}],
            [],
            (event) => {
                events.push(structuredClone(event));
            },
        );

        assert.deepEqual(
            events.map((event) => event.type),
            ["start", "text_delta", "text_delta", "done"],
        );
        assert.equal(events[1]?.type === "text_delta" && events[1].partial.content, "Hel");
        assert.equal(events[2]?.type === "text_delta" && events[2].partial.content, "Hello");
        assert.equal(result.content, "Hello");
    } finally {
        globalThis.fetch = originalFetch;
        process.env.OPENAI_API_KEY = originalApiKey;
        process.env.OPENAI_BASE_URL = originalBaseUrl;
        process.env.OPENAI_MODEL = originalModel;
    }
});
```

运行：

```powershell
npx tsx --test test/real-llm.test.ts
```

预期：编译失败，提示不存在 `LlmStreamEvent`，证明新协议尚未实现。

## Step 2：定义模型流事件

在 `src/types.ts` 增加：

```ts
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
```

把 `LlmClient.chatStream` 改成：

```ts
chatStream(
    messages: AgentMessage[],
    tools: Tool[],
    onEvent: LlmStreamListener,
    options?: LlmRequestOptions,
): Promise<AssistantMessage>;
```

## Step 3：让 SSE 读取器等待异步监听器

`readSseChunks` 的签名改成：

```ts
async function readSseChunks(
    response: Response,
    onChunk: (chunk: StreamChunk) => void | Promise<void>,
): Promise<void> {
```

解析普通数据帧时必须等待：

```ts
await onChunk(JSON.parse(payload) as StreamChunk);
```

这样事件监听器执行完成后才读取下一帧，事件顺序稳定。

## Step 4：修改 RealLlmClient

在文件顶部补充 `LlmStreamEvent` 或 `LlmStreamListener` 的类型导入。`chatStream` 的核心结构改为：

```ts
async chatStream(
    messages: AgentMessage[],
    tools: Tool[],
    onEvent: LlmStreamListener,
    options?: LlmRequestOptions,
): Promise<AssistantMessage> {
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
            messages: toApiMessages(messages, options?.systemPrompt),
            tools: toApiTools(tools),
            tool_choice: "auto",
        }),
    });

    if (!response.ok) {
        throw new Error(`模型请求失败：${response.status} ${await response.text()}`);
    }

    let content = "";
    const fragments = new Map<number, {
        id: string;
        name: string;
        argumentsText: string;
    }>();

    await onEvent({
        type: "start",
        partial: {role: "assistant", content: ""},
    });

    await readSseChunks(response, async (chunk) => {
        const delta = chunk.choices[0]?.delta;
        if (!delta) return;

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
            let current = fragments.get(index);
            if (!current) {
                current = {
                    id: fragment.id ?? "",
                    name: fragment.function?.name ?? "",
                    argumentsText: "",
                };
                fragments.set(index, current);
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

    const toolCalls = [...fragments.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([, fragment]) => ({
            id: fragment.id,
            name: fragment.name,
            arguments: fragment.argumentsText
                ? parseToolArguments(fragment.argumentsText)
                : {},
        }));

    const message: AssistantMessage = {
        role: "assistant",
        content,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };

    await onEvent({type: "done", message});
    return message;
}
```

工具参数在 `done` 前可能不是合法 JSON，因此 `toolcall_delta.partial` 暂时只携带累计文本，最终工具调用只放在 `done.message`。

## Step 5：同步 FakeLlmClient 和 Agent

`FakeLlmClient.chatStream`：

```ts
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
```

`RealLlmClient` 与 `FakeLlmClient` 必须遵守同一条约束：`toolcall_delta` 只是“工具调用碎片发生变化”的通知，`partial` 中只放当前累计文本；完整 `toolCalls` 只允许出现在 `done.message`。这样 Fake 不会让测试依赖真实 SSE 中不存在的中间结构。

如果 `RealLlmClient` 中还保留直接打印终端的 `streamText()` 演示方法，本任务删除该方法及其测试。先用下面的命令确认没有生产调用点：

```powershell
rg "streamText\(" src test
```

模型适配器只负责返回语义事件，终端打印由 Task 3 的 AgentEvent 订阅者接管。

`agent.ts` 暂时保持旧终端效果：

```ts
(event) => {
    if (event.type === "text_delta") {
        process.stdout.write(event.delta);
    }
},
```

## Step 6：验证

```powershell
npx tsx --test test/real-llm.test.ts test/agent.test.ts
npm test
npm run check
```

预期：所有命令退出码为 0；真实模型的终端输出方式暂时不变。

建议提交：

```text
refactor(agent): emit semantic llm stream events
```
