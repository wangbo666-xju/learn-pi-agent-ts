# Task 4：运行控制与双层 Loop Implementation Plan

**Goal:** 实现运行互斥、取消、等待、继续，以及 steer/followUp 两种消息队列。

**Architecture:** `Agent` 持有 `activeRun`、一个始终正常完成的 idle Promise、`AbortController` 和两个队列；Loop 在每个 Turn 完成后轮询 steer，在当前任务完成后轮询 followUp。

**Depends on:** Task 3。

## 修改范围

```text
新增 src/message-queue.ts
新增 test/message-queue.test.ts
修改 src/types.ts
修改 src/agent.ts
修改 src/agent-loop.ts
修改 src/real-llm.ts
修改 test/agent.test.ts
修改 package.json
```

## Step 1：实现前先写 MessageQueue 测试

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {MessageQueue} from "../src/message-queue.ts";

test("drain 按顺序返回消息并清空队列", () => {
    const queue = new MessageQueue();
    queue.enqueue({role: "user", content: "one"});
    queue.enqueue({role: "user", content: "two"});

    assert.deepEqual(queue.drain().map((message) => message.content), [
        "one",
        "two",
    ]);
    assert.deepEqual(queue.drain(), []);
});
```

运行并确认因模块不存在而失败：

```powershell
npx tsx --test test/message-queue.test.ts
```

## Step 2：实现队列

创建 `src/message-queue.ts`：

```ts
import type {UserMessage} from "./types.ts";

export class MessageQueue {
    private readonly messages: UserMessage[] = [];

    enqueue(message: UserMessage): void {
        this.messages.push(structuredClone(message));
    }

    drain(): UserMessage[] {
        return this.messages
            .splice(0)
            .map((message) => structuredClone(message));
    }

    clear(): void {
        this.messages.length = 0;
    }

    get size(): number {
        return this.messages.length;
    }
}
```

## Step 3：贯穿 AbortSignal

为 `LlmRequestOptions` 增加：

```ts
signal?: AbortSignal;
```

`RealLlmClient.chat()` 和 `chatStream()` 的 fetch 配置都增加：

```ts
signal: options?.signal,
```

`AgentLoopConfig` 增加：

```ts
signal?: AbortSignal;
pollSteering?: () => UserMessage[];
pollFollowUp?: () => UserMessage[];
shouldStopAfterTurn?: (
    input: {
        message: AssistantMessage;
        toolResults: ToolResultMessage[];
        context: AgentContext;
        newMessages: AgentMessage[];
    },
    signal?: AbortSignal,
) => boolean | Promise<boolean>;
```

`prepareLlmContext()` 和 `chatStream()` 都接收 `config.signal`。每轮开始和工具执行后检查：

```ts
if (config.signal?.aborted) {
    return finish("aborted");
}
```

其中 `finish(reason)` 必须发出一次 `agent_end` 并返回 `AgentRunResult`，避免每个分支重复构造。

## Step 4：实现双层循环

把 Task 3 的 for 循环改成下面的控制结构：

```ts
let pendingMessages = [...initialMessages];
let turn = 0;

do {
    await appendAndEmitMessages(pendingMessages);
    pendingMessages = [];

    while (true) {
        turn++;
        if (turn > config.maxTurns) return finish("max_turns");

        const {reply, toolResults} = await runTurn();

        if (await config.shouldStopAfterTurn?.({
            message: reply,
            toolResults,
            context,
            newMessages,
        }, config.signal)) {
            return finish("terminated");
        }

        const steering = config.pollSteering?.() ?? [];
        if (steering.length > 0) {
            await appendAndEmitMessages(steering);
            continue;
        }

        if (toolResults.length > 0) {
            continue;
        }

        break;
    }

    pendingMessages = config.pollFollowUp?.() ?? [];
} while (pendingMessages.length > 0);

return finish("completed");
```

`appendAndEmitMessages()` 和 `runTurn()` 是 `runAgentLoop()` 内的局部异步函数，使用当前 `context/newMessages/emit`，不要导出新的公共 API。外层使用 `do...while`，保证 `continue()` 传入空 initialMessages 时仍然执行一次模型 Turn。

固定优先级：

```text
abort/maxTurns
→ shouldStopAfterTurn
→ steer
→ toolResult 自动下一轮
→ followUp
→ completed
```

## Step 5：Agent 公开控制 API

增加字段：

```ts
private activeRun?: Promise<AgentRunResult>;
private idlePromise: Promise<void> = Promise.resolve();
private resolveIdle?: () => void;
private abortController?: AbortController;
private readonly steeringQueue = new MessageQueue();
private readonly followUpQueue = new MessageQueue();
```

Task 3 已经在异步工厂中读取 Session，并通过 `initialMessages` 初始化 State。`prompt()` 中不能再出现 `await sessionStore.getMessages()`；它必须同步建立运行锁并返回本轮 Promise：

```ts
prompt(text: string): Promise<AgentRunResult> {
    return this.startRun([{role: "user", content: text}]);
}
```

公共方法：

```ts
steer(message: UserMessage): void {
    this.steeringQueue.enqueue(message);
}

followUp(message: UserMessage): void {
    this.followUpQueue.enqueue(message);
}

abort(): void {
    this.abortController?.abort();
}

async waitForIdle(): Promise<void> {
    await this.idlePromise;
}

reset(): void {
    if (this.activeRun) {
        throw new Error("Agent 正在运行，不能 reset");
    }
    this._state.messages = [];
    this._state.streamingMessage = undefined;
    this._state.pendingToolCalls = new Set<string>();
    this._state.errorMessage = undefined;
    this.steeringQueue.clear();
    this.followUpQueue.clear();
}
```

`activeRun` 保留原始执行结果，可能 reject；`idlePromise` 只表示生命周期已经收尾，永远 resolve。CLI 退出时等待后者，不会把已经展示过的模型错误再次抛出。

`prompt()` 和 `continue()` 共用私有 `startRun(initialMessages)`。这个方法本身不能是 `async`，也不能在设置 `idlePromise` 和 `activeRun` 前执行任何 `await`：

```ts
private startRun(
    initialMessages: AgentMessage[],
): Promise<AgentRunResult> {
    if (this.activeRun) {
        throw new Error("Agent is already running");
    }

    let resolveIdle: () => void;
    this.idlePromise = new Promise<void>((resolve) => {
        resolveIdle = resolve;
    });
    this.resolveIdle = resolveIdle!;

    const controller = new AbortController();
    this.abortController = controller;

    // 延迟到微任务中启动 Loop，保证 activeRun 先于任何 Loop 事件建立。
    const run = Promise.resolve().then(() => runAgentLoop(
        initialMessages,
        this._state,
        {
            llm: this.llm,
            maxTurns: this.maxTurns,
            emit: (event) => this.handleEvent(event),
            beforeToolCall: this.beforeToolCall,
            transformContext: this.transformContext,
            convertToLlm: this.convertToLlm,
            shouldStopAfterTurn: this.shouldStopAfterTurn,
            signal: controller.signal,
            pollSteering: () => this.steeringQueue.drain(),
            pollFollowUp: () => this.followUpQueue.drain(),
        },
    ));

    this.activeRun = run;
    void run
        .then(undefined, (error: unknown) => {
            this._state.errorMessage = error instanceof Error
                ? error.message
                : String(error);
        })
        .finally(() => {
            if (this.activeRun === run) {
                this.activeRun = undefined;
                this.abortController = undefined;
                this.resolveIdle?.();
                this.resolveIdle = undefined;
            }
        });

    return run;
}
```

`runAgentLoop()` 捕获模型因 abort 产生的异常时，如果 `config.signal?.aborted` 为 true，调用 `finish("aborted")`；否则保持 Task 3 的错误事件并重新抛出。这样 `/abort` 是正常停止原因，真正的网络错误仍交给调用者。

Agent 构造函数必须保存 `transformContext`、`convertToLlm` 和 `shouldStopAfterTurn`，`startRun()` 再把它们全部传给 Loop。否则选项虽然出现在公开类型里，运行时却完全不生效。

## Step 6：实现 continue()

```ts
async continue(): Promise<AgentRunResult> {
    if (this.activeRun) {
        throw new Error("Agent is already running");
    }

    const last = this._state.messages.at(-1);
    if (!last) throw new Error("没有可继续的消息");

    if (last.role === "assistant") {
        const steering = this.steeringQueue.drain();
        if (steering.length > 0) return this.startRun(steering);

        const followUps = this.followUpQueue.drain();
        if (followUps.length > 0) return this.startRun(followUps);

        throw new Error("不能从 assistant 消息直接继续");
    }

    return this.startRun([]);
}
```

`runAgentLoop` 必须允许 `initialMessages=[]` 时直接进入一次内层 Turn，这是 continue 的入口；不要把空数组直接判断为 completed。

## Step 7：补运行控制测试

在 `test/agent.test.ts` 增加以下独立测试：

```text
运行中再次 prompt → 拒绝
abort → reason 为 aborted 且 isRunning=false
waitForIdle → 在 agent_end 后返回
steer 与 followUp 同时存在 → LLM 先看到 steer，最后看到 followUp
prompt 后立刻 waitForIdle → 不会提前返回
模型请求失败后 waitForIdle → 正常 resolve，不重复抛出模型错误
abort SSE → streamingMessage 最终为 undefined
continue 覆盖空历史、toolResult、assistant+steer、assistant+followUp 四条分支
shouldStop、steer、工具结果、followUp 同时满足 → 严格遵守固定优先级
```

Fake LLM 用一个可控 Promise 暂停当前轮，不调用真实网络。每个测试只断言一个行为。

## Step 8：验证

```powershell
npx tsx --test test/message-queue.test.ts test/agent.test.ts test/agent-loop.test.ts
npm test
npm run check
```

建议提交：

```text
feat(agent): add run control steering and follow-ups
```
