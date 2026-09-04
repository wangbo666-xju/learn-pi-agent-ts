# Task 3：事件驱动 Agent Loop Implementation Plan

**Goal:** 把现有 `Agent.prompt()` 中的 while 循环抽到 `agent-loop.ts`，用 Task 1 的事件更新 State，并从 Agent Core 移除终端打印。

**Architecture:** `runAgentLoop` 负责消息、模型和工具的执行顺序；`Agent` 是有状态控制器和事件入口；`main.ts` 订阅文本事件完成终端渲染。

**Depends on:** Task 1、Task 2A、Task 2B。

## 修改范围

```text
新增 src/agent-loop.ts
新增 test/agent-loop.test.ts
修改 src/execute-tools.ts
修改 src/agent.ts
修改 src/main.ts
修改 test/agent.test.ts
修改 package.json
```

## Step 1：先写事件顺序测试

创建 `test/agent-loop.test.ts`，先覆盖无工具路径：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {runAgentLoop} from "../src/agent-loop.ts";
import {FakeLlmClient} from "../src/fake-llm.ts";
import type {AgentEvent} from "../src/agent-events.ts";
import type {AgentContext} from "../src/agent-loop.ts";

test("直接回答时发出完整消息生命周期", async () => {
    const events: AgentEvent[] = [];
    const context: AgentContext = {
        systemPrompt: "",
        messages: [],
        tools: [],
    };

    const result = await runAgentLoop(
        [{role: "user", content: "hello"}],
        context,
        {
            llm: new FakeLlmClient([
                {role: "assistant", content: "world"},
            ]),
            maxTurns: 10,
            emit: (event) => {
                events.push(structuredClone(event));
            },
        },
    );

    assert.equal(result.reason, "completed");
    assert.deepEqual(events.map((event) => event.type), [
        "agent_start",
        "message_start",
        "message_end",
        "turn_start",
        "message_start",
        "message_update",
        "message_end",
        "turn_end",
        "agent_end",
    ]);
    assert.deepEqual(context.messages.map((message) => message.role), [
        "user",
        "assistant",
    ]);
});
```

运行并确认因为 `runAgentLoop` 不存在而失败：

```powershell
npx tsx --test test/agent-loop.test.ts
```

## Step 2：定义 Loop 接口

创建 `src/agent-loop.ts`，先定义边界：

```ts
import type {AgentEventListener, AgentStopReason} from "./agent-events.ts";
import type {ConvertToLlm, TransformContext} from "./context.ts";
import {
    defaultConvertToLlm,
    identityTransformContext,
    prepareLlmContext,
} from "./context.ts";
import type {
    AgentMessage,
    AssistantMessage,
    BeforeToolCall,
    LlmClient,
    Tool,
} from "./types.ts";

export type AgentContext = {
    systemPrompt: string;
    messages: AgentMessage[];
    tools: Tool[];
};

export type AgentRunResult = {
    newMessages: AgentMessage[];
    finalMessage?: AssistantMessage;
    reason: AgentStopReason;
};

export type AgentLoopConfig = {
    llm: LlmClient;
    maxTurns: number;
    emit: AgentEventListener;
    beforeToolCall?: BeforeToolCall;
    transformContext?: TransformContext;
    convertToLlm?: ConvertToLlm;
};
```

## Step 3：让 executeTools 发出工具事件

将第三个位置参数改成选项对象：

```ts
export type ExecuteToolsOptions = {
    beforeToolCall?: BeforeToolCall;
    emit?: AgentEventListener;
};

export async function executeTools(
    tools: Tool[],
    message: AssistantMessage,
    options: ExecuteToolsOptions = {},
): Promise<{contexts: ToolRunContext[]; results: ToolResultMessage[]}> {
```

每个工具真正执行前：

```ts
await options.emit?.({
    type: "tool_execution_start",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    args: toolCall.arguments,
});
```

工具结果确定后，使用当次成功结果或错误结果发出：

```ts
const executionResult: ToolExecutionResult = {
    content,
    details,
};

await options.emit?.({
    type: "tool_execution_end",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    result: executionResult,
    isError,
});
```

原调用点 `executeTools(tools, reply, beforeToolCall)` 改成：

```ts
executeTools(tools, reply, {beforeToolCall, emit});
```

## Step 4：实现 runAgentLoop

核心实现保持单层循环；双队列留到 Task 4：

```ts
export async function runAgentLoop(
    initialMessages: AgentMessage[],
    context: AgentContext,
    config: AgentLoopConfig,
): Promise<AgentRunResult> {
    const newMessages: AgentMessage[] = [];
    const emit = config.emit;
    let finalMessage: AssistantMessage | undefined;
    let agentEnded = false;

    async function emitAgentEnd(reason: AgentStopReason): Promise<void> {
        if (agentEnded) return;
        // 先置位再发布；即使某个 agent_end 监听器报错，也不能重复发布。
        agentEnded = true;
        await emit({type: "agent_end", reason, newMessages});
    }

    async function finish(reason: AgentStopReason): Promise<AgentRunResult> {
        const result: AgentRunResult = {newMessages, finalMessage, reason};
        await emitAgentEnd(reason);
        return result;
    }

    try {
        // 整个生命周期都必须在 try 内。message_end 持久化失败时仍要进入错误收尾。
        await emit({type: "agent_start"});

        for (const message of initialMessages) {
            await emit({type: "message_start", message});
            context.messages.push(message);
            newMessages.push(message);
            await emit({type: "message_end", message});
        }

        for (let turn = 1; turn <= config.maxTurns; turn++) {
            await emit({type: "turn_start", turn});

            const llmMessages = await prepareLlmContext(
                context.messages,
                config.transformContext ?? identityTransformContext,
                config.convertToLlm ?? defaultConvertToLlm,
            );

            let assistantWasAdded = false;
            const reply = await config.llm.chatStream(
                llmMessages,
                context.tools,
                async (event) => {
                    if (event.type === "start") {
                        await emit({type: "message_start", message: event.partial});
                    } else if (event.type === "text_delta") {
                        await emit({
                            type: "message_update",
                            message: event.partial,
                            update: {type: "text_delta", delta: event.delta},
                        });
                    } else if (event.type === "toolcall_delta") {
                        await emit({
                            type: "message_update",
                            message: event.partial,
                            update: {type: "toolcall_delta"},
                        });
                    } else {
                        context.messages.push(event.message);
                        newMessages.push(event.message);
                        assistantWasAdded = true;
                        await emit({type: "message_end", message: event.message});
                    }
                },
                {systemPrompt: context.systemPrompt},
            );

            if (!assistantWasAdded) {
                context.messages.push(reply);
                newMessages.push(reply);
                await emit({type: "message_end", message: reply});
            }

            finalMessage = reply;
            const {results} = await executeTools(
                context.tools,
                reply,
                {
                    beforeToolCall: config.beforeToolCall,
                    emit,
                },
            );

            for (const result of results) {
                await emit({type: "message_start", message: result});
                context.messages.push(result);
                newMessages.push(result);
                await emit({type: "message_end", message: result});
            }

            await emit({type: "turn_end", turn, message: reply, toolResults: results});

            if (results.length === 0) return finish("completed");
        }

        return finish("max_turns");
    } catch (error) {
        await emitAgentEnd("error");
        throw error;
    }
}
```

`emitAgentEnd()` 是唯一结束出口，并且必须在发布前设置幂等标记。这样成功、最大轮数、模型异常和 `message_end` 监听器异常都只产生一次 `agent_end`。`agent_end` 只发送它声明的 `reason/newMessages`，不展开含有 `finalMessage` 的整个 RunResult。

## Step 5：Agent 变成控制器

在 `Agent` 中增加：

```ts
private readonly events = new AgentEventBus();
private readonly _state: AgentState;

get state(): AgentState {
    return this._state;
}

subscribe(listener: AgentEventListener): () => void {
    return this.events.subscribe(listener);
}
```

构造函数改为接收选项对象，并用已经加载好的历史消息创建 State。不要在 `prompt()` 中读取 Session，否则 Task 4 无法在第一次 `await` 前建立运行锁：

```ts
export type AgentOptions = {
    llm: LlmClient;
    tools: Tool[];
    sessionStore: SessionStore;
    beforeToolCall?: BeforeToolCall;
    systemPrompt?: string;
    initialMessages?: AgentMessage[];
    maxTurns?: number;
    transformContext?: TransformContext;
    convertToLlm?: ConvertToLlm;
};

constructor(options: AgentOptions) {
    this.llm = options.llm;
    this.sessionStore = options.sessionStore;
    this.beforeToolCall = options.beforeToolCall;
    this.maxTurns = options.maxTurns ?? 10;
    this.transformContext = options.transformContext;
    this.convertToLlm = options.convertToLlm;
    this._state = createAgentState({
        systemPrompt: options.systemPrompt ?? "",
        tools: options.tools,
        messages: options.initialMessages ?? [],
    });
}
```

`prompt()` 只启动 Loop，不再异步加载历史：

```ts
async prompt(text: string): Promise<AgentMessage[]> {
    const result = await runAgentLoop(
        [{role: "user", content: text}],
        this._state,
        {
            llm: this.llm,
            maxTurns: this.maxTurns,
            beforeToolCall: this.beforeToolCall,
            transformContext: this.transformContext,
            convertToLlm: this.convertToLlm,
            emit: async (event) => {
                this.applyEvent(event);
                // Task 6 会把 Session 保存提取成独立订阅器；在此之前保持现有持久化行为。
                if (event.type === "message_end") {
                    await this.sessionStore.appendMessage(event.message);
                }
                await this.events.emit(event);
            },
        },
    );

    return [...this._state.messages];
}
```

在 `main.ts` 组装 Agent 前完成一次历史读取：

```ts
async function createAgent(sessionStore: SessionStore): Promise<Agent> {
    const initialMessages = await sessionStore.getMessages();
    return new Agent({
        llm,
        tools,
        sessionStore,
        beforeToolCall: policy,
        systemPrompt,
        initialMessages,
    });
}
```

不要等整个 Run 结束后批量保存：如果后续模型请求失败，前面已经完成的 user、assistant 和 toolResult 仍然应该留在 Session。Task 6 只会把这里的 `message_end` 保存逻辑提取成独立监听器，不改变保存时机。

消息所有权固定为：Loop 在消息完整时直接写入 `context.messages`；由于传入的 `context` 就是当前 `AgentState`，State 会同步得到完整 transcript。`applyEvent()` 不再重复追加消息，只维护流式状态、工具状态和运行状态：

```ts
private applyEvent(event: AgentEvent): void {
    if (event.type === "agent_start") {
        this._state.isRunning = true;
        this._state.errorMessage = undefined;
    } else if (event.type === "message_start" && event.message.role === "assistant") {
        this._state.streamingMessage = event.message;
    } else if (event.type === "message_update") {
        this._state.streamingMessage = event.message;
    } else if (event.type === "message_end" && event.message.role === "assistant") {
        this._state.streamingMessage = undefined;
    } else if (event.type === "tool_execution_start") {
        this._state.pendingToolCalls = new Set([
            ...this._state.pendingToolCalls,
            event.toolCallId,
        ]);
    } else if (event.type === "tool_execution_end") {
        const pending = new Set(this._state.pendingToolCalls);
        pending.delete(event.toolCallId);
        this._state.pendingToolCalls = pending;
    } else if (event.type === "agent_end") {
        this._state.isRunning = false;
        this._state.streamingMessage = undefined;
        this._state.pendingToolCalls = new Set<string>();
    }
}
```

`agent_end` 必须清空 partial 和 pending 状态。否则 SSE 中止或工具执行中止后，CLI 会永久显示一个已经不存在的流式消息或工具调用。

## Step 6：把打印移到 main.ts

创建 Agent 后注册：

```ts
agent.subscribe((event) => {
    if (
        event.type === "message_update" &&
        event.update.type === "text_delta"
    ) {
        process.stdout.write(event.update.delta);
    }

    if (event.type === "tool_execution_end") {
        console.log(
            `\n工具执行状态：${event.toolName}:${event.isError ? "error" : "done"}`,
        );
    }
});
```

删除 `agent.ts` 中所有 `process.stdout.write()` 和 `console.log()`。

## Step 7：补工具路径测试并验证

增加测试，断言工具事件顺序：

```text
message_end(assistant)
→ tool_execution_start
→ tool_execution_end
→ message_start(toolResult)
→ message_end(toolResult)
→ turn_end
→ turn_start
```

运行：

```powershell
npx tsx --test test/agent-loop.test.ts test/agent.test.ts
npm test
npm run check
```

建议提交：

```text
refactor(agent): extract event-driven agent loop
```
