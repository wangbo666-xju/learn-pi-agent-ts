# 第一阶段：AgentState 与 AgentEvent

## 1. 这一阶段解决什么问题

当前 `Agent` 已经能运行，但运行状态分散在 `prompt()` 的局部变量中，SSE 文本也由 Agent 直接打印。

这一阶段只建立两个基础设施：

```text
AgentState：描述 Agent 当前是什么状态
AgentEvent：描述 Agent 刚刚发生了什么
```

两者关系：

```text
Agent Loop 发生变化
  → 发出 AgentEvent
  → Agent 根据事件更新 AgentState
  → CLI、Session、测试也可以订阅同一个事件
```

本阶段不会修改现有 `agent.ts`，也不会改变现有运行效果。下一阶段再把 Agent Loop 接进来。

## 2. 文件结构

新增四个文件：

```text
src/
  agent-state.ts
  agent-events.ts

test/
  agent-state.test.ts
  agent-events.test.ts
```

职责：

| 文件 | 职责 |
|---|---|
| `agent-state.ts` | 定义状态结构，并创建初始状态 |
| `agent-events.ts` | 定义事件结构，并负责订阅和发布事件 |
| `agent-state.test.ts` | 验证初始状态不会直接复用外部数组 |
| `agent-events.test.ts` | 验证监听顺序、异步等待和取消订阅 |

## 3. 第一步：先写失败测试

### 3.1 `test/agent-state.test.ts`

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {createAgentState} from "../src/agent-state.ts";
import type {AgentMessage, Tool} from "../src/types.ts";

test("创建 AgentState 时复制消息和工具数组", () => {
    const messages: AgentMessage[] = [
        {
            role: "user",
            content: "你好",
        },
    ];
    const tools: Tool[] = [];

    const state = createAgentState({
        systemPrompt: "你是一个编程助手",
        messages,
        tools,
    });

    // 修改构造参数的数组，不能影响已经创建的 AgentState。
    messages.push({
        role: "user",
        content: "后加入的消息",
    });

    assert.equal(state.systemPrompt, "你是一个编程助手");
    assert.equal(state.messages.length, 1);
    assert.equal(state.isRunning, false);
    assert.equal(state.streamingMessage, undefined);
    assert.equal(state.pendingToolCalls.size, 0);

    assert.notStrictEqual(state.messages, messages);
    assert.notStrictEqual(state.tools, tools);
});
```

这个测试防止以后把外部传入的数组直接存进 State，导致调用者在 Agent 外修改数组时意外改变内部状态。

### 3.2 `test/agent-events.test.ts`

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {AgentEventBus} from "../src/agent-events.ts";

test("事件监听器按照注册顺序执行并等待异步监听器", async () => {
    const calls: string[] = [];
    const eventBus = new AgentEventBus();

    eventBus.subscribe(async () => {
        calls.push("first:start");
        await Promise.resolve();
        calls.push("first:end");
    });

    eventBus.subscribe(() => {
        calls.push("second");
    });

    await eventBus.emit({
        type: "agent_start",
    });

    assert.deepEqual(calls, [
        "first:start",
        "first:end",
        "second",
    ]);
});

test("取消订阅后不再接收事件", async () => {
    let receivedCount = 0;
    const eventBus = new AgentEventBus();

    const unsubscribe = eventBus.subscribe(() => {
        receivedCount++;
    });

    await eventBus.emit({
        type: "agent_start",
    });

    unsubscribe();

    await eventBus.emit({
        type: "agent_start",
    });

    assert.equal(receivedCount, 1);
});
```

第一个测试保证异步 Session 监听器保存完消息后，Loop 才会继续；第二个测试保证切换 Session 或销毁 CLI 时能够移除旧监听器。

### 3.3 运行失败测试

```powershell
npx tsx --test test/agent-state.test.ts test/agent-events.test.ts
```

预期结果：测试失败，提示找不到 `agent-state.ts` 和 `agent-events.ts`。这说明测试确实覆盖了尚未实现的新能力。

## 4. 第二步：实现 AgentState

创建 `src/agent-state.ts`：

```ts
import type {
    AgentMessage,
    AssistantMessage,
    Tool,
} from "./types.ts";

/**
 * Agent 在当前进程中的实时状态。
 *
 * Session 负责跨进程持久化；AgentState 负责描述当前正在运行什么。
 */
export type AgentState = {
    /** 每次请求模型时可以使用的完整上下文。 */
    messages: AgentMessage[];

    /** 当前系统提示词，包括 Skill 索引。 */
    systemPrompt: string;

    /** 当前允许模型调用的工具。 */
    tools: Tool[];

    /** 从 agent_start 到 agent_end 之间为 true。 */
    isRunning: boolean;

    /** SSE 期间正在不断被完整快照替换的 assistant 消息。 */
    streamingMessage?: AssistantMessage;

    /** 当前正在执行的工具调用 ID。 */
    pendingToolCalls: ReadonlySet<string>;

    /** 本轮模型或运行时错误；下一次正常运行开始时清空。 */
    errorMessage?: string;
};

export type CreateAgentStateInput = {
    messages?: AgentMessage[];
    systemPrompt?: string;
    tools?: Tool[];
};

/**
 * 创建 Agent 初始状态。
 *
 * 这里只复制顶层数组：Agent 可以追加或替换数组元素，
 * 但不会因为调用者继续 push 原数组而被意外修改。
 */
export function createAgentState(
    input: CreateAgentStateInput = {},
): AgentState {
    return {
        messages: [...(input.messages ?? [])],
        systemPrompt: input.systemPrompt ?? "",
        tools: [...(input.tools ?? [])],
        isRunning: false,
        pendingToolCalls: new Set<string>(),
    };
}
```

### 为什么 State 里还要存 messages

`SessionStore` 和 `AgentState.messages` 作用不同：

```text
SessionStore
  → 已经完成并落盘的历史消息

AgentState.messages
  → 当前运行使用的内存上下文
```

流式 assistant 尚未完成时，只放在 `streamingMessage`；收到 `message_end` 后再进入 `messages` 和 Session。

## 5. 第三步：实现 AgentEvent

创建 `src/agent-events.ts`：

```ts
import type {
    AgentMessage,
    AssistantMessage,
    ToolArguments,
    ToolExecutionResult,
    ToolResultMessage,
} from "./types.ts";

/** Agent 本轮停止的原因。 */
export type AgentStopReason =
    | "completed"
    | "aborted"
    | "max_turns"
    | "terminated"
    | "error";

/** 模型流式生成 assistant 消息时的一次增量。 */
export type AssistantMessageUpdate =
    | {
        type: "text_delta";
        delta: string;
    }
    | {
        type: "toolcall_delta";
    };

/**
 * Agent 对外发布的生命周期事件。
 *
 * message_update 携带的是当前完整 partial 快照，
 * update 只描述本次发生的增量类型。
 */
export type AgentEvent =
    | {
        type: "agent_start";
    }
    | {
        type: "agent_end";
        reason: AgentStopReason;
        newMessages: AgentMessage[];
    }
    | {
        type: "turn_start";
        turn: number;
    }
    | {
        type: "turn_end";
        turn: number;
        message: AssistantMessage;
        toolResults: ToolResultMessage[];
    }
    | {
        type: "message_start";
        message: AgentMessage;
    }
    | {
        type: "message_update";
        message: AssistantMessage;
        update: AssistantMessageUpdate;
    }
    | {
        type: "message_end";
        message: AgentMessage;
    }
    | {
        type: "tool_execution_start";
        toolCallId: string;
        toolName: string;
        args: ToolArguments;
    }
    | {
        type: "tool_execution_update";
        toolCallId: string;
        toolName: string;
        partialResult: ToolExecutionResult;
    }
    | {
        type: "tool_execution_end";
        toolCallId: string;
        toolName: string;
        result: ToolExecutionResult;
        isError: boolean;
    };

export type AgentEventListener = (
    event: AgentEvent,
) => void | Promise<void>;

/**
 * Agent 内部使用的最小事件总线。
 *
 * 监听器按照注册顺序执行，并逐个等待完成。
 * Session 监听器因此可以在 message_end 阶段完成落盘。
 */
export class AgentEventBus {
    private readonly listeners = new Set<AgentEventListener>();

    /** 注册监听器，返回取消订阅函数。 */
    subscribe(listener: AgentEventListener): () => void {
        this.listeners.add(listener);

        return () => {
            this.listeners.delete(listener);
        };
    }

    /** 按照注册顺序发布并等待所有监听器。 */
    async emit(event: AgentEvent): Promise<void> {
        for (const listener of this.listeners) {
            await listener(event);
        }
    }
}
```

## 6. 第四步：验证实现

先运行本阶段测试：

```powershell
npx tsx --test test/agent-state.test.ts test/agent-events.test.ts
```

预期：3 个测试全部通过。

再运行类型检查：

```powershell
npx tsc --noEmit
```

最后把新测试追加到 `package.json` 的 `test` 命令中：

```json
{
  "scripts": {
    "test": "tsx --test test/agent.test.ts test/memory-session-store.test.ts test/jsonl-session-store.test.ts test/session-manager.test.ts test/skills.test.ts test/real-llm.test.ts test/cli-agent-runner.test.ts test/agent-state.test.ts test/agent-events.test.ts"
  }
}
```

然后运行完整测试：

```powershell
npm test
```

## 7. 建议断点位置

### `createAgentState()` 的 return

观察：

```text
messages 是否是新数组
isRunning 是否为 false
pendingToolCalls 是否为空
```

### `AgentEventBus.subscribe()`

观察监听器如何进入 `listeners`。

### `AgentEventBus.emit()` 的 for 循环

单步执行可以看到：

```text
第一个监听器开始
→ await 第一个监听器完成
→ 第二个监听器开始
```

这就是以后 Session 能在 `message_end` 时可靠落盘的基础。

## 8. 本阶段完成后的效果

这一阶段完成后，程序外观暂时不会变化，但已经得到后续重构需要的两个统一协议：

```text
AgentState
  → 外部可以查看 Agent 当前状态

AgentEventBus
  → Agent、CLI、Session 和测试使用同一套生命周期事件
```

下一阶段才会修改 `RealLlmClient.chatStream()`：把当前的 `onText(text)` 改为语义流事件，并让 Agent Loop 发出这里定义的 `message_start/update/end`。

## 9. 建议提交信息

```text
feat(agent): 增加 AgentState 与生命周期事件协议
```
