# Task 6：Session 事件持久化 Implementation Plan

**Goal:** 删除 Agent Loop 中散落的 `appendMessage()`，统一在 `message_end` 事件发生时保存完整消息。

**Architecture:** Session 是 AgentEvent 的一个可等待订阅者。partial 消息只更新内存 State，完整 user/assistant/toolResult 才进入 JSONL。

**Depends on:** Task 5。

## 修改范围

```text
新增 src/session/session-event-listener.ts
新增 test/session-event-listener.test.ts
修改 src/agent.ts
修改 src/main.ts
修改 test/agent.test.ts
修改 test/jsonl-session-store.test.ts
修改 package.json
```

## Step 1：先写持久化边界测试

创建 `test/session-event-listener.test.ts`：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {createSessionEventListener} from "../src/session/session-event-listener.ts";
import {MemorySessionStore} from "../src/session/memory-session-store.ts";

test("只在 message_end 时持久化完整消息", async () => {
    const store = new MemorySessionStore({
        id: "session-1",
        createdAt: 1000,
    });
    const listener = createSessionEventListener(store);
    const partial = {
        role: "assistant" as const,
        content: "par",
    };

    await listener({
        type: "message_start",
        message: {role: "assistant", content: ""},
    });
    await listener({
        type: "message_update",
        message: partial,
        update: {type: "text_delta", delta: "par"},
    });

    assert.deepEqual(await store.getMessages(), []);

    await listener({
        type: "message_end",
        message: {role: "assistant", content: "partial"},
    });

    assert.deepEqual(await store.getMessages(), [
        {role: "assistant", content: "partial"},
    ]);
});
```

运行并确认模块不存在：

```powershell
npx tsx --test test/session-event-listener.test.ts
```

## Step 2：实现监听器

创建 `src/session/session-event-listener.ts`：

```ts
import type {AgentEventListener} from "../agent-events.ts";
import type {SessionStore} from "./session-store.ts";

export function createSessionEventListener(
    store: SessionStore,
): AgentEventListener {
    return async (event) => {
        if (event.type === "message_end") {
            await store.appendMessage(event.message);
        }
    };
}
```

事件总线会等待监听器完成，因此 `message_end` 返回时，对应 JSONL 已经写完。

## Step 3：沿用 Agent 的异步初始化边界

Task 3 已经把 `SessionStore.getMessages()` 移到 `main.ts` 的异步工厂。本任务保留这个边界，但不再把 Store 传进 Agent：

```ts
async function createAgent(
    sessionStore: SessionStore,
): Promise<Agent> {
    const initialMessages = await sessionStore.getMessages();
    const llm = new RealLlmClient();
    const agent = new Agent({
        llm,
        tools: [
            new ReadFileTool(cwd),
            new WriteFileTool(cwd),
            new ListDirTool(cwd),
        ],
        beforeToolCall: policy,
        systemPrompt,
        initialMessages,
    });

    agent.subscribe(createSessionEventListener(sessionStore));
    // Task 7 才创建 createCliEventRenderer；此处继续使用 Task 3 的内联 CLI 事件订阅器。
    agent.subscribe((event) => {
        if (event.type === "message_update" && event.update.type === "text_delta") {
            stdout.write(event.update.delta);
        }
    });
    return agent;
}
```

Task 3/4 应已把 `Agent` 构造函数改为选项对象；固定选项类型：

```ts
export type AgentOptions = {
    llm: LlmClient;
    tools: Tool[];
    beforeToolCall?: BeforeToolCall;
    afterToolCall?: AfterToolCall;
    systemPrompt?: string;
    initialMessages?: AgentMessage[];
    maxTurns?: number;
    transformContext?: TransformContext;
    convertToLlm?: ConvertToLlm;
    shouldStopAfterTurn?: AgentLoopConfig["shouldStopAfterTurn"];
};
```

如果前面仍保留位置参数，应在本任务统一改为该选项对象，并同步测试调用点。构造函数必须保存这些配置，`startRun()` 必须把 `beforeToolCall`、`afterToolCall`、`transformContext`、`convertToLlm` 和 `shouldStopAfterTurn` 全部传给 Loop。

## Step 4：删除重复保存

从 `Agent.prompt()`、`Agent.startRun()` 和 `agent-loop.ts` 中删除所有：

```ts
sessionStore.appendMessage(...)
```

Agent Core 不再持有 `SessionStore`。Session 只通过订阅器接收完整消息。

`/new` 和 `/resume` 改成：

```ts
sessionStore = await sessionManager.create();
agent = await createAgent(sessionStore);
```

```ts
sessionStore = await sessionManager.open(command.sessionId);
agent = await createAgent(sessionStore);
```

## Step 5：补恢复集成测试

使用临时 JSONL 文件完成以下真实流程：

```text
创建 Store A 和 Agent A
→ Agent A prompt("第一次")
→ 打开同一个 JSONL 得到 Store B
→ 用 Store B 的 messages 创建 Agent B
→ Agent B prompt("第二次")
→ 第二次 Fake LLM 请求包含第一次 user/assistant 和第二次 user
```

断言 JSONL 中每条消息只出现一次，避免 Event Listener 与旧手工保存同时执行。

再增加异常测试：让一个 SessionStore 的 `appendMessage()` 主动抛错，执行 Prompt 后断言：

```text
prompt Promise reject
agent_end 仍只发布一次
isRunning=false
streamingMessage=undefined
pendingToolCalls 为空
waitForIdle 正常 resolve
```

这证明持久化失败不会把 Agent 留在“永久运行中”的脏状态。

## Step 6：验证

```powershell
npx tsx --test test/session-event-listener.test.ts test/jsonl-session-store.test.ts test/agent.test.ts
npm test
npm run check
```

建议提交：

```text
refactor(agent): persist completed messages through events
```
