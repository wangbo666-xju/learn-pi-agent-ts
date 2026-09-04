# Task 7：CLI 运行控制 Implementation Plan

**Goal:** 让 CLI 只负责命令和事件展示，并能在 Agent 运行期间调用 status、abort、steer 和 followUp。

**Architecture:** 普通 Prompt 在后台运行，readline 继续接收控制命令；CLI 通过 `Agent.subscribe()` 渲染流式文本和工具状态，不访问 Loop 内部变量。

**Depends on:** Task 6。

## 修改范围

```text
新增 src/cli-event-renderer.ts
新增 test/cli-command.test.ts
新增 test/cli-event-renderer.test.ts
修改 src/cli-command.ts
修改 src/cli-agent-runner.ts
修改 src/main.ts
修改 package.json
```

## Step 1：先写命令解析测试

创建 `test/cli-command.test.ts`：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {parseCliCommand} from "../src/cli-command.ts";

test("解析 Agent 运行控制命令", () => {
    assert.deepEqual(parseCliCommand("/status"), {type: "status"});
    assert.deepEqual(parseCliCommand("/abort"), {type: "abort"});
    assert.deepEqual(parseCliCommand("/steer 改为只读"), {
        type: "steer",
        text: "改为只读",
    });
    assert.deepEqual(parseCliCommand("/followup 总结结果"), {
        type: "followup",
        text: "总结结果",
    });
});
```

运行并确认新增命令走到普通 prompt 或类型不存在：

```powershell
npx tsx --test test/cli-command.test.ts
```

## Step 2：扩展命令协议

`CliCommand` 增加：

```ts
| {type: "status"}
| {type: "abort"}
| {type: "steer"; text?: string}
| {type: "followup"; text?: string}
```

switch 增加：

```ts
case "/status":
    return {type: "status"};
case "/abort":
    return {type: "abort"};
case "/steer":
    return {type: "steer", text: args.join(" ") || undefined};
case "/followup":
    return {type: "followup", text: args.join(" ") || undefined};
```

## Step 3：先写渲染器测试

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {createCliEventRenderer} from "../src/cli-event-renderer.ts";

test("只把 text_delta 写到流式输出", async () => {
    const output: string[] = [];
    const render = createCliEventRenderer((text) => output.push(text));

    await render({
        type: "message_update",
        message: {role: "assistant", content: "Hello"},
        update: {type: "text_delta", delta: "Hello"},
    });
    await render({
        type: "message_update",
        message: {role: "assistant", content: "Hello", toolCalls: []},
        update: {type: "toolcall_delta"},
    });

    assert.deepEqual(output, ["Hello"]);
});
```

## Step 4：实现 CLI Event Renderer

创建 `src/cli-event-renderer.ts`：

```ts
import type {AgentEventListener} from "./agent-events.ts";

export function createCliEventRenderer(
    write: (text: string) => void,
): AgentEventListener {
    return (event) => {
        if (
            event.type === "message_update" &&
            event.update.type === "text_delta"
        ) {
            write(event.update.delta);
            return;
        }

        if (event.type === "tool_execution_end") {
            const state = event.isError ? "error" : "done";
            write(`\n工具执行状态：${event.toolName}:${state}\n`);
        }
    };
}
```

## Step 5：让 Prompt 不阻塞控制命令

`main.ts` 中不要再 `await runAgentPrompt(...)` 后才读取下一行。维护当前 Promise：

```ts
let activePrompt: Promise<unknown> | undefined;

function startPrompt(text: string): void {
    if (agent.state.isRunning) {
        console.log("Agent 正在运行，请使用 /steer、/followup 或 /abort");
        return;
    }

    const run = agent.prompt(text);
    activePrompt = run;
    void run
        .catch((error: unknown) => {
            const message = error instanceof Error
                ? error.message
                : String(error);
            console.log(`\n执行失败：${message}`);
        })
        .finally(() => {
            if (activePrompt === run) activePrompt = undefined;
        });
}
```

普通 `prompt` 和显式 Skill 都调用 `startPrompt(text)`。

## Step 6：路由控制命令

```ts
if (command.type === "status") {
    console.log({
        isRunning: agent.state.isRunning,
        pendingToolCalls: [...agent.state.pendingToolCalls],
        errorMessage: agent.state.errorMessage,
    });
    continue;
}

if (command.type === "abort") {
    agent.abort();
    continue;
}

if (command.type === "steer") {
    if (!command.text) {
        console.log("用法：/steer <新的要求>");
    } else if (!agent.state.isRunning) {
        console.log("Agent 当前没有运行中的任务");
    } else {
        agent.steer({role: "user", content: command.text});
    }
    continue;
}

if (command.type === "followup") {
    if (!command.text) {
        console.log("用法：/followup <后续要求>");
    } else if (!agent.state.isRunning) {
        console.log("Agent 当前没有运行中的任务");
    } else {
        agent.followUp({role: "user", content: command.text});
    }
    continue;
}
```

Agent 运行时只禁止 `/new` 和 `/resume`，否则旧 Run 的事件可能写到新 Session。不要用一个无条件 guard 拦住 `/status`、`/abort`、`/steer` 和 `/followup`：

```ts
if (
    agent.state.isRunning &&
    (command.type === "new" || command.type === "resume")
) {
    console.log("请先等待当前任务结束，或使用 /abort");
    continue;
}
```

退出前：

```ts
agent.abort();
await agent.waitForIdle();
```

## Step 7：更新帮助并验证

帮助增加：

```text
/status             查看 Agent 状态
/abort              中止当前运行
/steer <要求>       当前 Turn 后优先改变方向
/followup <要求>    当前任务结束后继续
```

运行：

```powershell
npx tsx --test test/cli-command.test.ts test/cli-event-renderer.test.ts
npm test
npm run check
npm run dev
```

手工验证运行中输入 `/status`、`/steer`、`/followup` 和 `/abort`，并确认 `/new` 不会在运行中切换 Session。

增加一个 CLI runner 测试：运行期间 `/abort` 能到达 `agent.abort()`，而 `/new` 和 `/resume` 被拒绝。这样可以防止后续调整命令分支顺序时把控制命令一起拦截。

建议提交：

```text
feat(agent): expose runtime controls in cli
```
