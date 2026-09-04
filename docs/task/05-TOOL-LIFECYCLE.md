# Task 5：完整工具生命周期 Implementation Plan

**Goal:** 将工具调用固定为“查找、校验、before、execute、after、结果”的管线，并让进度、取消和 terminate 真正生效。

**Architecture:** `executeTools` 是唯一工具编排入口；单个 Tool 只实现业务动作。错误统一转换为 `ToolResultMessage`，不会因单个工具失败中断 Agent。

**Depends on:** Task 4。

## 修改范围

```text
新增 src/tool-arguments.ts
新增 test/execute-tools.test.ts
修改 src/types.ts
修改 src/execute-tools.ts
修改 src/agent-loop.ts
修改 src/agent.ts
修改 src/tools/*.ts
修改 package.json
```

## Step 1：先写参数校验测试

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {validateToolArguments} from "../src/tool-arguments.ts";
import type {Tool} from "../src/types.ts";

const tool: Tool = {
    name: "write",
    description: "test",
    parameters: {
        type: "object",
        properties: {
            path: {type: "string"},
            content: {type: "string"},
        },
        required: ["path", "content"],
        additionalProperties: false,
    },
    async execute() {
        return {content: "ok"};
    },
};

test("拒绝缺少 required 字段的工具参数", () => {
    assert.throws(
        () => validateToolArguments(tool, {path: "a.txt"}),
        /缺少参数：content/,
    );
});

test("拒绝 schema 未声明的额外字段", () => {
    assert.throws(
        () => validateToolArguments(tool, {
            path: "a.txt",
            content: "a",
            unexpected: true,
        }),
        /未知参数：unexpected/,
    );
});
```

运行并确认模块不存在：

```powershell
npx tsx --test test/execute-tools.test.ts
```

## Step 2：实现学习版 Schema 校验

创建 `src/tool-arguments.ts`：

```ts
import type {Tool, ToolArguments} from "./types.ts";

type PropertySchema = {
    type?: unknown;
};

type ObjectSchema = {
    type?: unknown;
    properties?: Record<string, PropertySchema>;
    required?: unknown;
    additionalProperties?: unknown;
};

export function validateToolArguments(
    tool: Tool,
    args: ToolArguments,
): ToolArguments {
    const schema = tool.parameters as ObjectSchema;
    if (schema.type !== "object") {
        throw new Error(`工具 ${tool.name} 的 parameters.type 必须是 object`);
    }

    const required = Array.isArray(schema.required)
        ? schema.required.filter((item): item is string => typeof item === "string")
        : [];

    for (const name of required) {
        if (!(name in args)) throw new Error(`缺少参数：${name}`);
    }

    const properties = schema.properties ?? {};
    for (const [name, value] of Object.entries(args)) {
        const property = properties[name];
        if (!property) {
            if (schema.additionalProperties === false) {
                throw new Error(`未知参数：${name}`);
            }
            continue;
        }
        if (property.type === "string" && typeof value !== "string") {
            throw new Error(`参数 ${name} 必须是 string`);
        }
    }

    return args;
}
```

## Step 3：扩展工具和 Hook 类型

在 `src/types.ts` 定义：

```ts
export type ToolUpdateCallback = (
    partialResult: ToolExecutionResult,
) => void | Promise<void>;

export interface Tool {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute(
        args: ToolArguments,
        signal?: AbortSignal,
        onUpdate?: ToolUpdateCallback,
    ): Promise<ToolExecutionResult>;
}

export type AfterToolCall = (
    input: {
        toolCall: ToolCall;
        result: ToolExecutionResult;
        isError: boolean;
    },
    signal?: AbortSignal,
) => Promise<{
    result?: ToolExecutionResult;
    isError?: boolean;
} | undefined>;

// 修改项目中已有的 BeforeToolCallResult，不要重复声明第二份同名类型。
export type BeforeToolCallResult = {
    block: boolean;
    reason?: string;
    terminate?: boolean;
};
```

文件工具签名同步增加可选参数。执行 Node 文件 API 前检查：

```ts
if (signal?.aborted) {
    throw new Error("Operation aborted");
}
```

## Step 4：重写 executeTools 的单次管线

选项类型固定为：

```ts
export type ExecuteToolsOptions = {
    beforeToolCall?: BeforeToolCall;
    afterToolCall?: AfterToolCall;
    emit?: AgentEventListener;
    signal?: AbortSignal;
};

export type ExecuteToolsResult = {
    results: ToolResultMessage[];
    allTerminated: boolean;
};
```

每个 toolCall 严格按以下顺序：

```text
emit tool_execution_start
→ find tool
→ validateToolArguments
→ beforeToolCall
→ tool.execute(signal, onUpdate)，把成功或异常统一为内部 result
→ afterToolCall，即使 tool.execute 失败也执行
→ emit tool_execution_end
→ create ToolResultMessage
```

`onUpdate` 必须等待事件监听器：

```ts
const output = await tool.execute(
    validatedArgs,
    options.signal,
    async (partialResult) => {
        await options.emit?.({
            type: "tool_execution_update",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            partialResult,
        });
    },
);
```

`tool.execute()` 抛错时先转换成内部错误结果，不要立刻返回：

```ts
let output: ToolExecutionResult;
let isError = false;
try {
    output = await tool.execute(validatedArgs, options.signal, onUpdate);
} catch (error) {
    output = {
        content: `工具执行失败: ${error instanceof Error ? error.message : String(error)}`,
    };
    isError = true;
}
```

然后无论执行成功还是失败都调用 after Hook，使它可以脱敏、统一错误文案或把可恢复错误改成成功结果：

```ts
const override = await options.afterToolCall?.(
    {toolCall, result: output, isError},
    options.signal,
);
const finalResult = override?.result ?? output;
const finalIsError = override?.isError ?? isError;
```

找不到工具、参数校验失败、before Hook 抛错时没有发生 `tool.execute()`，因此不调用 after Hook，直接转换成错误结果。after Hook 自身抛错也转换成：

```ts
{
    role: "toolResult",
    toolCallId: toolCall.id,
    content: `工具执行失败: ${message}`,
    isError: true,
}
```

`beforeToolCall` 主动拦截时必须构造内部结果，并把终止语义带入统计：

```ts
const blockedResult: ToolExecutionResult = {
    content: decision.reason ?? "工具调用被策略拦截",
    terminate: decision.terminate,
};
outcomes.push({result: blockedResult, isError: true});
```

随后仍然发布一次 `tool_execution_end` 并生成 `isError: true` 的 `ToolResultMessage`。如果 `{block: true, terminate: true}` 没有映射成该内部结果，`allTerminated` 将永远看不到 before Hook 的终止决定。

Task 3 已用 AgentEvent 表达实时工具状态，因此本任务把 `executeTools()` 的返回值简化为 `{results, allTerminated}`。确认没有其他引用后删除旧 `contexts` 数组和只为控制台展示存在的 `ToolRunContext` 类型。

## Step 5：实现 terminate

`terminate` 只保留在 `ToolExecutionResult`、被拦截的 `BeforeToolCallResult` 和 `ExecuteToolsResult.allTerminated`，不要写入 `ToolResultMessage` 或 JSONL。

```ts
const allTerminated = outcomes.length > 0 &&
    outcomes.every((outcome) => outcome.result.terminate === true);
```

其中 `outcomes` 是 `executeTools()` 内部为每个 toolCall 保存的最终 `{result, isError}` 数组；找不到工具、参数错误和普通异常都写入没有 `terminate` 的错误结果，因此不会误判为全部终止。

Loop 的 Turn 优先级改成：

```text
abort/maxTurns
→ shouldStopAfterTurn
→ steer
→ allTerminated=false 且有 toolResult：自动下一轮
→ followUp
→ allTerminated=true 时 terminated，否则 completed
```

在 `AgentLoopConfig` 增加 `afterToolCall?: AfterToolCall`，在 `AgentOptions` 保存它，并由 `startRun()` 传给 Loop，再由 Loop 传入 `executeTools()`。公开选项、Agent 字段、Loop 配置和工具执行器四层必须贯通。

## Step 6：补执行管线测试

在 `test/execute-tools.test.ts` 分别验证：

```text
缺少参数时 Tool.execute 未调用，返回 isError=true
beforeToolCall.block 时 Tool.execute 未调用
beforeToolCall 返回 terminate=true 时会计入 allTerminated
成功时 afterToolCall 可以改写结果
Tool.execute 抛错时 afterToolCall 仍会收到 isError=true
onUpdate 产生 tool_execution_update
全部结果 terminate=true 时 allTerminated=true
一个 terminate=false 时 allTerminated=false
```

每个测试使用内存 TestTool，不调用真实文件系统。

## Step 7：验证

```powershell
npx tsx --test test/execute-tools.test.ts test/agent-loop.test.ts test/agent.test.ts
npm test
npm run check
```

建议提交：

```text
feat(agent): complete tool execution lifecycle
```
