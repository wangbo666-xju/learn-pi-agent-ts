# Pi Agent 学习版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 Loop、SSE、Tool、Session 和 Skill 基础上，补齐状态、事件、运行控制、双层循环和上下文边界，完成 Pi 风格学习版 Agent Core。

**Architecture:** `Agent` 作为有状态控制器，`agent-loop` 作为执行引擎，模型适配器只产生流式语义事件。所有 UI 和 Session 行为都通过可等待的 `AgentEvent` 订阅完成，现有 JSONL 与 Skill 格式保持不变。

**Tech Stack:** TypeScript 7、Node.js 24、`tsx`、`node:test`、原生 `fetch` 与 Web Streams。

**Spec:** `docs/PI_AGENT_LEARNING_DESIGN.md`

## Global Constraints

- 保留现有 DeepSeek/OpenAI 兼容接口、JSONL Session 和 Skill 文件格式。
- 使用 Node strip-only mode 可执行的 TypeScript，不使用参数属性、`enum` 或 `namespace`。
- 不使用 `any`，纯类型使用 `import type`。
- 第一版工具继续顺序执行，不增加并行调度。
- 每个任务先写失败测试，再写最小实现。
- 每个任务完成后运行对应测试和 `npx tsc --noEmit`。
- 不修改或删除已有 Session 数据。

---

### Task 1: AgentState 与 AgentEvent 协议

**Files:**
- Create: `src/agent-state.ts`
- Create: `src/agent-events.ts`
- Modify: `src/types.ts`
- Test: `test/agent-state.test.ts`
- Test: `test/agent-events.test.ts`

**Interfaces:**
- Consumes: 现有 `AgentMessage`、`AssistantMessage` 和 `Tool`。
- Produces: `AgentState`、`AgentEvent`、`AgentEventListener`、`AgentEventBus`。

- [ ] **Step 1: 写 AgentState 失败测试**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {createAgentState} from "../src/agent-state.ts";

test("创建状态时复制输入消息和工具数组", () => {
    const messages = [{role: "user" as const, content: "hello"}];
    const state = createAgentState({messages, tools: [], systemPrompt: "system"});

    messages.push({role: "user", content: "later"});

    assert.equal(state.messages.length, 1);
    assert.equal(state.isRunning, false);
    assert.equal(state.streamingMessage, undefined);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npx tsx --test test/agent-state.test.ts`

Expected: FAIL，提示找不到 `agent-state.ts` 或 `createAgentState`。

- [ ] **Step 3: 实现 AgentState**

```ts
import type {AgentMessage, AssistantMessage, Tool} from "./types.ts";

export type AgentState = {
    systemPrompt: string;
    messages: AgentMessage[];
    tools: Tool[];
    isRunning: boolean;
    streamingMessage?: AssistantMessage;
    pendingToolCalls: ReadonlySet<string>;
    errorMessage?: string;
};

export function createAgentState(input: {
    systemPrompt: string;
    messages: AgentMessage[];
    tools: Tool[];
}): AgentState {
    return {
        systemPrompt: input.systemPrompt,
        messages: [...input.messages],
        tools: [...input.tools],
        isRunning: false,
        pendingToolCalls: new Set<string>(),
    };
}
```

- [ ] **Step 4: 写可等待事件总线测试**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {AgentEventBus} from "../src/agent-events.ts";

test("事件监听器按注册顺序执行并等待完成", async () => {
    const calls: string[] = [];
    const bus = new AgentEventBus();

    bus.subscribe(async () => {
        await Promise.resolve();
        calls.push("first");
    });
    bus.subscribe(() => {
        calls.push("second");
    });

    await bus.emit({type: "agent_start"});
    assert.deepEqual(calls, ["first", "second"]);
});
```

- [ ] **Step 5: 实现最小事件协议和事件总线**

```ts
import type {AgentMessage, AssistantMessage, ToolArguments, ToolResultMessage} from "./types.ts";

export type AgentStopReason = "completed" | "aborted" | "max_turns" | "terminated" | "error";

export type AssistantMessageUpdate =
    | {type: "text_delta"; delta: string}
    | {type: "toolcall_delta"};

export type AgentEvent =
    | {type: "agent_start"}
    | {type: "agent_end"; reason: AgentStopReason; newMessages: AgentMessage[]}
    | {type: "turn_start"; turn: number}
    | {type: "turn_end"; turn: number; message: AssistantMessage; toolResults: ToolResultMessage[]}
    | {type: "message_start"; message: AgentMessage}
    | {type: "message_update"; message: AssistantMessage; update: AssistantMessageUpdate}
    | {type: "message_end"; message: AgentMessage}
    | {type: "tool_execution_start"; toolCallId: string; toolName: string; args: ToolArguments}
    | {type: "tool_execution_update"; toolCallId: string; content: string}
    | {type: "tool_execution_end"; toolCallId: string; content: string; isError: boolean};

export type AgentEventListener = (event: AgentEvent) => void | Promise<void>;

export class AgentEventBus {
    private readonly listeners = new Set<AgentEventListener>();

    subscribe(listener: AgentEventListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    async emit(event: AgentEvent): Promise<void> {
        for (const listener of this.listeners) {
            await listener(event);
        }
    }
}
```

- [ ] **Step 6: 验证并提交**

Run: `npx tsx --test test/agent-state.test.ts test/agent-events.test.ts`

Run: `npx tsc --noEmit`

```text
feat(agent): add agent state and lifecycle events
```

---

### Task 2: 模型语义流与 Context 管线

**Files:**
- Create: `src/context.ts`
- Modify: `src/types.ts`
- Modify: `src/real-llm.ts`
- Modify: `src/fake-llm.ts`
- Test: `test/context.test.ts`
- Test: `test/real-llm.test.ts`

**Interfaces:**
- Consumes: `AgentMessage[]` 和现有 OpenAI 兼容 SSE。
- Produces: `LlmMessage`、`LlmStreamEvent`、`TransformContext`、`ConvertToLlm`。

- [ ] **Step 1: 写 Context 顺序测试**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {prepareLlmContext} from "../src/context.ts";

test("先 transformContext 再 convertToLlm", async () => {
    const calls: string[] = [];
    const result = await prepareLlmContext(
        [{role: "user", content: "raw"}],
        async (messages) => {
            calls.push("transform");
            return [...messages, {role: "user", content: "injected"}];
        },
        (messages) => {
            calls.push("convert");
            return messages;
        },
    );

    assert.deepEqual(calls, ["transform", "convert"]);
    assert.equal(result.length, 2);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npx tsx --test test/context.test.ts`

Expected: FAIL，提示找不到 `prepareLlmContext`。

- [ ] **Step 3: 定义并实现 Context 接口**

```ts
export type LlmMessage = UserMessage | AssistantMessage | ToolResultMessage;

export type TransformContext = (
    messages: AgentMessage[],
    signal?: AbortSignal,
) => Promise<AgentMessage[]>;

export type ConvertToLlm = (messages: AgentMessage[]) => LlmMessage[];
```

```ts
export async function prepareLlmContext(
    messages: AgentMessage[],
    transformContext: TransformContext,
    convertToLlm: ConvertToLlm,
    signal?: AbortSignal,
): Promise<LlmMessage[]> {
    const transformed = await transformContext([...messages], signal);
    return convertToLlm(transformed);
}
```

默认实现原样返回，并只保留 `user`、`assistant`、`toolResult`。

- [ ] **Step 4: 把 `chatStream` 改成语义流回调**

```ts
export type LlmStreamEvent =
    | {type: "start"; partial: AssistantMessage}
    | {type: "text_delta"; delta: string; partial: AssistantMessage}
    | {type: "toolcall_delta"; partial: AssistantMessage}
    | {type: "done"; message: AssistantMessage};
```

将 `LlmClient.chatStream` 改为：

```ts
chatStream(
    messages: LlmMessage[],
    tools: Tool[],
    onEvent: (event: LlmStreamEvent) => void | Promise<void>,
    options?: LlmRequestOptions,
): Promise<AssistantMessage>;
```

`RealLlmClient` 不再调用 `process.stdout.write()`；每次 SSE 更新累计快照后调用 `onEvent`。

- [ ] **Step 5: 增加 SSE 事件顺序测试**

在现有 fetch mock 中返回包含两个 `data:` 文本帧和 `[DONE]` 的 `ReadableStream`，断言：

```ts
assert.deepEqual(events.map((event) => event.type), [
    "start",
    "text_delta",
    "text_delta",
    "done",
]);
```

- [ ] **Step 6: 验证并提交**

Run: `npx tsx --test test/context.test.ts test/real-llm.test.ts`

Run: `npx tsc --noEmit`

```text
refactor(agent): separate model stream from context preparation
```

---

### Task 3: 抽取 agent-loop 并接入状态事件

**Files:**
- Create: `src/agent-loop.ts`
- Modify: `src/agent.ts`
- Modify: `src/execute-tools.ts`
- Test: `test/agent-loop.test.ts`
- Modify: `test/agent.test.ts`

**Interfaces:**
- Consumes: `AgentState`、`LlmClient`、Context 管线和 `AgentEventBus.emit()`。
- Produces: `runAgentLoop()` 和 `AgentRunResult`。

- [ ] **Step 1: 写无工具事件顺序失败测试**

```ts
test("直接回答时发出完整生命周期", async () => {
    const eventTypes: string[] = [];
    const result = await runAgentLoop({
        initialMessages: [{role: "user", content: "hello"}],
        context: {systemPrompt: "", messages: [], tools: []},
        llm: new FakeLlmClient([{role: "assistant", content: "world"}]),
        emit: async (event) => eventTypes.push(event.type),
        transformContext: async (messages) => messages,
        convertToLlm: (messages) => messages,
        maxTurns: 10,
    });

    assert.equal(result.reason, "completed");
    assert.deepEqual(eventTypes, [
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
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npx tsx --test test/agent-loop.test.ts`

Expected: FAIL，提示找不到 `runAgentLoop`。

- [ ] **Step 3: 实现单层 `runAgentLoop`**

定义：

```ts
export type AgentRunResult = {
    newMessages: AgentMessage[];
    finalMessage?: AssistantMessage;
    reason: AgentStopReason;
};
```

`runAgentLoop()` 负责：

1. 发出并追加初始消息。
2. 每轮发出 `turn_start`。
3. 将 LLM `start/update/done` 映射为 Agent 消息事件。
4. 完成 assistant 后执行工具。
5. 发出 toolResult 的 `message_start/message_end`。
6. 发出 `turn_end`，无工具时返回 completed。
7. 达到 `maxTurns` 时发出 `agent_end(reason: "max_turns")`。

- [ ] **Step 4: 让 Agent 只负责调用 Loop 和更新 AgentState**

`Agent.prompt()` 不再直接打印文本，也不包含工具 while 循环。它把初始 user 消息传给 `runAgentLoop()`，并通过内部事件处理器更新：

```text
agent_start    → isRunning = true
message_update → streamingMessage = event.message
message_end    → messages.push(event.message)，清空 streamingMessage
agent_end      → isRunning = false
```

- [ ] **Step 5: 验证工具调用事件和原有行为**

补充测试断言：

```text
assistant message_end
→ tool_execution_start
→ tool_execution_end
→ toolResult message_end
→ 下一次 turn_start
```

- [ ] **Step 6: 验证并提交**

Run: `npx tsx --test test/agent-loop.test.ts test/agent.test.ts`

Run: `npx tsc --noEmit`

```text
refactor(agent): extract event-driven agent loop
```

---

### Task 4: 运行控制和双消息队列

**Files:**
- Create: `src/message-queue.ts`
- Modify: `src/agent.ts`
- Modify: `src/agent-loop.ts`
- Test: `test/message-queue.test.ts`
- Modify: `test/agent.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `runAgentLoop()` 和 `AgentRunResult`。
- Produces: `steer()`、`followUp()`、`continue()`、`abort()`、`waitForIdle()`、`reset()`。

- [ ] **Step 1: 写队列失败测试**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {MessageQueue} from "../src/message-queue.ts";

test("drain 返回现有消息并清空队列", () => {
    const queue = new MessageQueue();
    queue.enqueue({role: "user", content: "one"});
    queue.enqueue({role: "user", content: "two"});

    assert.equal(queue.drain().length, 2);
    assert.equal(queue.drain().length, 0);
});
```

- [ ] **Step 2: 实现 MessageQueue**

```ts
export class MessageQueue {
    private readonly messages: UserMessage[] = [];

    enqueue(message: UserMessage): void {
        this.messages.push(structuredClone(message));
    }

    drain(): UserMessage[] {
        return this.messages.splice(0).map((message) => structuredClone(message));
    }

    clear(): void {
        this.messages.length = 0;
    }
}
```

- [ ] **Step 3: 写运行互斥、abort 和 waitForIdle 测试**

使用一个等待 `AbortSignal` 的 Fake LLM，断言：

```text
第一次 prompt 运行中再次 prompt → 抛出 Agent is already running
abort() → 当前 Run 返回 aborted
waitForIdle() → 在 agent_end 后完成
```

- [ ] **Step 4: 在 Agent 中实现运行控制**

```ts
private activeRun?: Promise<AgentRunResult>;
private abortController?: AbortController;
```

- `prompt()` 和 `continue()` 共用私有 `startRun(initialMessages)`。
- `abort()` 调用当前 `AbortController.abort()`。
- `waitForIdle()` 等待 `activeRun`，没有运行时立即返回。
- `reset()` 只允许 idle 时调用，并清空消息、错误和两个队列。

- [ ] **Step 5: 实现双层 Loop 优先级**

在每次 `turn_end` 后按固定顺序处理：

```text
shouldStopAfterTurn
→ steeringQueue.drain()
→ 工具结果自动继续
→ 退出内层循环
→ followUpQueue.drain()
→ 下一次外层循环或结束
```

增加测试：当前 assistant 产生工具结果，同时队列中存在 steer 和 followUp，断言下一次 LLM 请求先看到 steer，当前任务结束后才看到 followUp。

- [ ] **Step 6: 实现 continue() 语义**

```text
最后一条为 user/toolResult → 不添加新消息，直接继续模型调用
最后一条为 assistant 且有 steer → 处理 steer
最后一条为 assistant 且有 followUp → 处理 followUp
其他情况 → 抛出明确错误
```

- [ ] **Step 7: 验证并提交**

Run: `npx tsx --test test/message-queue.test.ts test/agent.test.ts test/agent-loop.test.ts`

Run: `npx tsc --noEmit`

```text
feat(agent): add run control steering and follow-ups
```

---

### Task 5: 完整工具生命周期

**Files:**
- Modify: `src/types.ts`
- Modify: `src/execute-tools.ts`
- Modify: `src/tools/read-file-tool.ts`
- Modify: `src/tools/write-file-tool.ts`
- Modify: `src/tools/list-dir-tool.ts`
- Modify: `src/agent-loop.ts`
- Modify: `test/agent.test.ts`
- Create: `test/execute-tools.test.ts`

**Interfaces:**
- Consumes: `AgentEvent`、现有工具 Schema 和 `AbortSignal`。
- Produces: `AfterToolCall`、工具更新回调、集中参数校验和 `terminate` 行为。

- [ ] **Step 1: 写参数校验失败测试**

```ts
test("缺少 schema required 参数时不执行工具", async () => {
    const calls: ToolArguments[] = [];
    const result = await executeTools(
        [createTestTool(calls)],
        createAssistantToolCall({arguments: {}}),
        {emit: async () => undefined},
    );

    assert.equal(calls.length, 0);
    assert.equal(result.results[0]?.isError, true);
    assert.match(result.results[0]?.content ?? "", /缺少参数/);
});
```

- [ ] **Step 2: 实现学习版 Schema 校验**

新增 `validateToolArguments(tool, args)`，只支持当前项目需要的规则：

```text
parameters.type 必须为 object
required 字段必须存在
properties 中声明为 string 的字段必须是字符串
additionalProperties 为 false 时拒绝未知字段
```

校验错误转换成工具错误结果，不抛出 Agent Loop。

- [ ] **Step 3: 扩展工具执行签名**

```ts
export type ToolUpdateCallback = (content: string) => void | Promise<void>;

execute(
    args: ToolArguments,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback,
): Promise<ToolExecutionResult>;
```

文件工具在执行前检查 `signal?.aborted`。`executeTools` 把 `onUpdate` 转换成 `tool_execution_update` 事件。

- [ ] **Step 4: 增加 afterToolCall**

```ts
export type AfterToolCall = (
    input: {
        toolCall: ToolCall;
        result: ToolExecutionResult;
        isError: boolean;
    },
    signal?: AbortSignal,
) => Promise<Partial<ToolExecutionResult> & {isError?: boolean} | undefined>;
```

调用顺序固定为：

```text
validate
→ beforeToolCall
→ execute
→ afterToolCall
→ tool_execution_end
→ ToolResultMessage
```

- [ ] **Step 5: 让 terminate 生效**

`terminate` 是运行时控制信息，不写入 `ToolResultMessage`，避免污染模型上下文和 JSONL。扩展 `executeTools()` 的返回值：

```ts
type ExecuteToolsResult = {
    contexts: ToolRunContext[];
    results: ToolResultMessage[];
    allTerminated: boolean;
};
```

如果本批所有工具结果均为 `terminate: true`，跳过工具触发的自动 LLM 后续调用；仍然先检查 steer 和 followUp。没有排队消息时，Loop 以 `terminated` 结束。混合结果继续下一轮。

- [ ] **Step 6: 验证并提交**

Run: `npx tsx --test test/execute-tools.test.ts test/agent.test.ts test/agent-loop.test.ts`

Run: `npx tsc --noEmit`

```text
feat(agent): complete tool execution lifecycle
```

---

### Task 6: Session 改为事件驱动持久化

**Files:**
- Create: `src/session/session-event-listener.ts`
- Modify: `src/agent.ts`
- Modify: `src/main.ts`
- Modify: `test/jsonl-session-store.test.ts`
- Create: `test/session-event-listener.test.ts`

**Interfaces:**
- Consumes: `AgentEventListener` 和现有 `SessionStore`。
- Produces: `createSessionEventListener(sessionStore)`。

- [ ] **Step 1: 写只保存 message_end 的失败测试**

```ts
test("只在 message_end 时保存完整消息", async () => {
    const store = createMemoryStore();
    const listener = createSessionEventListener(store);
    const partial = {role: "assistant" as const, content: "par"};

    await listener({type: "message_start", message: partial});
    await listener({
        type: "message_update",
        message: partial,
        update: {
            type: "text_delta",
            delta: "par",
        },
    });
    assert.equal((await store.getMessages()).length, 0);

    await listener({type: "message_end", message: {role: "assistant", content: "partial"}});
    assert.equal((await store.getMessages()).length, 1);
});
```

- [ ] **Step 2: 实现 Session 事件监听器**

```ts
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

- [ ] **Step 3: 移除 Agent Loop 中的直接持久化**

由于 `SessionStore.getMessages()` 是异步方法，不在构造函数中读取。把 `main.ts` 的 `createAgent()` 改成异步工厂：

```ts
async function createAgent(sessionStore: SessionStore): Promise<Agent> {
    const initialMessages = await sessionStore.getMessages();
    const agent = new Agent({
        llm: new RealLlmClient(),
        tools: createTools(),
        systemPrompt,
        initialMessages,
        beforeToolCall: policy,
    });
    agent.subscribe(createSessionEventListener(sessionStore));
    return agent;
}
```

删除旧 `prompt()` 中直接调用 `appendMessage()` 的代码，避免重复保存。`/new` 和 `/resume` 都必须 `await createAgent(sessionStore)`。

- [ ] **Step 4: 验证恢复后继续对话**

测试流程：

```text
创建 JSONL Agent
→ prompt 第一次
→ 重新打开相同 JSONL
→ 创建新 Agent
→ prompt 第二次
→ 第二次 LLM 请求包含第一次完整历史
```

- [ ] **Step 5: 验证并提交**

Run: `npx tsx --test test/session-event-listener.test.ts test/jsonl-session-store.test.ts test/agent.test.ts`

Run: `npx tsc --noEmit`

```text
refactor(agent): persist completed messages through events
```

---

### Task 7: CLI 事件渲染和运行控制命令

**Files:**
- Create: `src/cli-event-renderer.ts`
- Modify: `src/cli-command.ts`
- Modify: `src/cli-agent-runner.ts`
- Modify: `src/main.ts`
- Create: `test/cli-command.test.ts`
- Create: `test/cli-event-renderer.test.ts`

**Interfaces:**
- Consumes: `Agent.subscribe()`、`Agent.state` 和 Task 4 的控制方法。
- Produces: `/status`、`/abort`、`/steer <text>`、`/followup <text>`。

- [ ] **Step 1: 写新命令解析失败测试**

```ts
assert.deepEqual(parseCliCommand("/abort"), {type: "abort"});
assert.deepEqual(parseCliCommand("/status"), {type: "status"});
assert.deepEqual(parseCliCommand("/steer 改为只读"), {type: "steer", text: "改为只读"});
assert.deepEqual(parseCliCommand("/followup 总结结果"), {type: "followup", text: "总结结果"});
```

- [ ] **Step 2: 扩展 CliCommand 并实现解析**

新增联合类型：

```ts
| {type: "abort"}
| {type: "status"}
| {type: "steer"; text?: string}
| {type: "followup"; text?: string}
```

缺少文本时由 `main.ts` 输出用法，不调用 Agent。

- [ ] **Step 3: 实现 CLI 事件渲染器**

```ts
export function createCliEventRenderer(
    write: (text: string) => void,
): AgentEventListener {
    return (event) => {
        if (
            event.type === "message_update" &&
            event.update.type === "text_delta"
        ) {
            write(event.update.delta);
        }
        if (event.type === "tool_execution_end") {
            write(`\n工具 ${event.toolCallId}: ${event.isError ? "error" : "done"}\n`);
        }
    };
}
```

- [ ] **Step 4: 让 CLI 在 Agent 运行时继续接收控制命令**

普通 Prompt 启动后保存 Promise，但不阻塞下一次 `question()`：

```ts
const run = agent.prompt(command.text);
void run.catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`\n执行失败：${message}`);
});
```

路由：

```text
/abort       → agent.abort()
/status      → 输出 isRunning、pendingToolCalls、errorMessage
/steer text  → agent.steer({role: "user", content: text})
/followup t  → agent.followUp({role: "user", content: text})
```

Agent 运行期间，`/new` 和 `/resume` 返回“请先等待或 /abort”，防止切换 Session 后旧 Run 的事件写入错误会话。`/exit` 先执行 `abort()`，再 `await waitForIdle()`。

- [ ] **Step 5: 更新帮助文本并手工验证**

Run: `npm run dev`

验证：

```text
普通问题能够流式显示
/status 能看到运行状态
运行期间 /steer 改变下一轮方向
/followup 在当前任务结束后执行
/abort 可以停止当前请求
/resume 后历史仍然存在
/skill:agent-ts-development 能正常执行
```

- [ ] **Step 6: 运行完整验证并提交**

Run: `npm test`

Run: `npx tsc --noEmit`

```text
feat(agent): expose runtime controls in cli
```

---

### Task 8: 文档收尾与完成验收

**Files:**
- Modify: `Readme.md`
- Modify: `docs/AGENT_EVOLUTION.md`
- Modify: `docs/TODO.md`
- Verify: `docs/PI_AGENT_LEARNING_DESIGN.md`

**Interfaces:**
- Consumes: Tasks 1-7 的最终公开 API。
- Produces: 与代码一致的项目入口、架构说明和完成状态。

- [ ] **Step 1: 更新 README**

README 必须包含：

```text
项目定位
安装与环境变量
npm run dev / npm test / npm run check
完整消息与工具调用流程
CLI 命令
源码目录说明
```

- [ ] **Step 2: 更新演进记录**

将 Session、Skill、AgentEvent、双层 Loop 和运行控制标记为已完成。历史阶段保留，不删除原学习记录。

- [ ] **Step 3: 更新 TODO**

删除已经完成的项目，只保留可选扩展：Compact、Session fork、并行工具、图片、Thinking、Usage 和 TUI。

- [ ] **Step 4: 运行最终验证**

Run: `npm test`

Expected: 全部测试通过，没有失败或跳过。

Run: `npm run check`

Expected: TypeScript 类型检查通过。

Run: `git diff --check`

Expected: 没有空白错误。

- [ ] **Step 5: 提交文档收尾**

```text
docs(agent): document pi-style learning agent architecture
```

## 完成后的可选演进

以下内容不影响学习版 Agent 的完成判定，按兴趣单独立项：

1. `transformContext` 中加入基于阈值的 Compact。
2. Session Entry 增加 `parentId`，实现最小 fork。
3. 工具增加 parallel/sequential 执行模式。
4. UserMessage 支持图片 Content Block。
5. SSE 支持 thinking 和 usage。
6. 用 TUI 替换当前 readline CLI。
