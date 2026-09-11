# Task 5：完整工具生命周期执行文档

## 改动总结、效果与原因

本任务把已有的“找到工具就执行”，补成统一的工具执行流程。

| 改动 | 完成后的效果 | 为什么需要 |
|---|---|---|
| 参数校验 | 缺少 path、类型错误等在执行前被拒绝 | 模型给出的参数不能只靠 TypeScript 类型保证 |
| before / execute / after | 策略、文件操作、结果处理各司其职 | 不用在每个工具里重复权限与脱敏逻辑 |
| signal / onUpdate | 工具配合取消，并发布执行进度 | Task 4 只解决模型取消，工具也需要接入 |
| terminate | 整批工具都要求停止时，不再自动请求模型 | 避免策略拦截后模型反复尝试同一操作 |
| 完整结果与事件 | 每个工具调用对应一个结果；普通工具错误可回传模型 | 保持模型上下文中的调用与结果配对 |

具体例子：模型要求写入 .env → before 拒绝并返回 terminate → 保存拒绝结果 → Run 返回 terminated，不再自动让模型“换个路径再试”。

**前置条件：** 已完成 04 文档，而不是保留旧 for 循环的半成品。
**目标接口：** executeTools(tools, reply, options) 返回 results、contexts、allTerminated。
**技术：** TypeScript、Node 文件 API、node:test；不新增依赖。
**设计依据：** [学习版设计](../PI_AGENT_LEARNING_DESIGN.md)、[Task 4](./04-RUN-CONTROL-AND-DOUBLE-LOOP.md)。

> 本文是手工实施文档。若交由 Agent 自动实施，应使用 executing-plans 按步骤执行；本文不会自动修改源码。

## 1. 文件清单与实施顺序

| 文件 | 操作 |
|---|---|
| src/types.ts | 替换 Tool、BeforeToolCallResult、BeforeToolCall；新增两个类型 |
| src/tool-arguments.ts | 新建完整文件 |
| src/execute-tools.ts | 整体替换 |
| src/agent-loop.ts | 接入 after/signal，修改终止判断 |
| src/agent.ts | 贯通 afterToolCall 的四个位置 |
| src/tools/read-file-tool.ts | 替换 execute 方法 |
| src/tools/write-file-tool.ts | 替换 execute 方法 |
| src/tools/list-dir-tool.ts | 替换 execute 方法 |
| test/execute-tools.test.ts | 新建完整文件 |
| package.json | 在 test 命令末尾追加测试文件 |

- [ ] 先创建第 7 节测试，运行并确认新接口尚未实现导致失败。
- [ ] 按第 2～6 节改代码。
- [ ] 执行第 8 节验证。

以下“完整文件”包含 import；“替换方法”只替换类内同名方法，其他代码保留。不要把 Markdown 围栏复制进 TS。

## 2. types.ts：精确修改的类型

替换已有 Tool、BeforeToolCallResult、BeforeToolCall，新增 ToolUpdateCallback、AfterToolCall。其他类型不变；ToolExecutionResult 已有 terminate，不要重复定义。

~~~ts
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

export type BeforeToolCallResult = {
    block: boolean;
    reason?: string;
    terminate?: boolean;
};

export type BeforeToolCall = (
    toolCall: ToolCall,
    signal?: AbortSignal,
) => Promise<BeforeToolCallResult | undefined>;

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
~~~

signal、onUpdate 都是可选参数，因此原来只有 execute(args) 的测试工具仍能实现 Tool。需要取消或进度的工具才读取它们。

## 3. 新建 src/tool-arguments.ts：完整文件

这是“当前文件工具使用的 Schema 子集”，不是完整 JSON Schema 校验器。只支持 object 根节点和 string 属性；不支持的属性类型明确报错，不假装校验通过。以后增加数字、数组工具时再扩展。

~~~ts
import type {Tool, ToolArguments} from "./types.ts";

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateToolArguments(
    tool: Tool,
    input: unknown,
): ToolArguments {
    const schema = tool.parameters;
    if (schema.type !== "object") {
        throw new Error("工具 " + tool.name + " 的 parameters.type 必须是 object");
    }
    if (!isObject(input)) throw new Error("工具参数必须是 object");

    const properties = schema.properties ?? {};
    if (!isObject(properties)) throw new Error("properties 必须是 object");
    const required = schema.required ?? [];
    if (!Array.isArray(required) || required.some((name) => typeof name !== "string")) {
        throw new Error("required 必须是字符串数组");
    }

    for (const name of required) {
        if (!Object.hasOwn(input, name)) throw new Error("缺少参数：" + name);
    }
    for (const [name, property] of Object.entries(properties)) {
        if (!isObject(property) || property.type !== "string") {
            throw new Error("学习版暂不支持属性类型：" + name);
        }
        if (Object.hasOwn(input, name) && typeof input[name] !== "string") {
            throw new Error("参数 " + name + " 必须是 string");
        }
    }
    if (schema.additionalProperties === false) {
        for (const name of Object.keys(input)) {
            if (!Object.hasOwn(properties, name)) throw new Error("未知参数：" + name);
        }
    }
    return input;
}
~~~

校验结果仍是 ToolArguments，因此具体工具里的 typeof 判断保留：工具也可能被业务代码直接调用，不经过 executeTools。

## 4. src/execute-tools.ts：整体替换

保留已有 contexts 返回值与 ToolRunContext，不在这个功能任务中顺手删除接口。CLI 仍以事件展示为准。

~~~ts
import type {AgentEventListener} from "./agent-events.ts";
import {validateToolArguments} from "./tool-arguments.ts";
import type {
    AfterToolCall,
    AssistantMessage,
    BeforeToolCall,
    Tool,
    ToolExecutionResult,
    ToolResultMessage,
    ToolRunContext,
} from "./types.ts";

export type ExecuteToolsOptions = {
    beforeToolCall?: BeforeToolCall;
    afterToolCall?: AfterToolCall;
    emit?: AgentEventListener;
    signal?: AbortSignal;
};

export type ExecuteToolsResult = {
    contexts: ToolRunContext[];
    results: ToolResultMessage[];
    allTerminated: boolean;
};

export async function executeTools(
    tools: Tool[],
    reply: AssistantMessage,
    options: ExecuteToolsOptions = {},
): Promise<ExecuteToolsResult> {
    const contexts: ToolRunContext[] = [];
    const results: ToolResultMessage[] = [];
    const outcomes: ToolExecutionResult[] = [];

    // 学习版固定串行。同一批次取消后，剩余调用不执行，但仍补错误结果。
    for (const toolCall of reply.toolCalls ?? []) {
        const context: ToolRunContext = {
            id: toolCall.id,
            name: toolCall.name,
            state: "running",
            startedAt: Date.now(),
            input: toolCall.arguments,
        };
        // 事件订阅失败属于基础设施错误，不能伪装成工具业务错误。
        await options.emit?.({
            type: "tool_execution_start",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            args: toolCall.arguments,
        });

        let result: ToolExecutionResult = {content: ""};
        let isError = false;
        let executed = false;
        let progressFailure: {cause: unknown} | undefined;

        try {
            options.signal?.throwIfAborted();
            const tool = tools.find((item) => item.name === toolCall.name);
            if (!tool) throw new Error("找不到工具：" + toolCall.name);

            const args = validateToolArguments(tool, toolCall.arguments);
            const decision = await options.beforeToolCall?.(toolCall, options.signal);
            options.signal?.throwIfAborted();

            if (decision?.block) {
                result = {
                    content: "工具调用被拒绝：" + (decision.reason ?? "策略拒绝执行"),
                    terminate: decision.terminate,
                };
                isError = true;
            } else {
                executed = true;
                result = await tool.execute(args, options.signal, async (partialResult) => {
                    options.signal?.throwIfAborted();
                    try {
                        await options.emit?.({
                            type: "tool_execution_update",
                            toolCallId: toolCall.id,
                            toolName: toolCall.name,
                            partialResult,
                        });
                    } catch (error) {
                        progressFailure = {cause: error};
                        throw error;
                    }
                });
                options.signal?.throwIfAborted();
            }
        } catch (error) {
            result = {
                content: options.signal?.aborted
                    ? "工具调用已取消；已发生的文件修改不会自动撤销"
                    : "工具执行失败: " + (error instanceof Error ? error.message : String(error)),
            };
            isError = true;
        }

        // 即使 Tool 自己捕获了 onUpdate 异常，也不能隐藏事件系统故障。
        if (progressFailure) throw progressFailure.cause;

        // 只对真正执行过的工具做后处理。取消时跳过，避免取消后仍做额外工作。
        // 普通 execute 异常仍进入 after，允许脱敏或转换错误文案。
        if (executed && !options.signal?.aborted) {
            try {
                const override = await options.afterToolCall?.(
                    {toolCall, result, isError},
                    options.signal,
                );
                result = override?.result ?? result;
                isError = override?.isError ?? isError;
            } catch (error) {
                result = {
                    content: "工具执行失败: " +
                        (error instanceof Error ? error.message : String(error)),
                };
                isError = true;
            }
        }

        context.state = isError ? "error" : "done";
        context.finishedAt = Date.now();
        if (isError) context.error = result.content;
        else context.output = result.content;
        contexts.push(context);
        outcomes.push(result);

        await options.emit?.({
            type: "tool_execution_end",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            result,
            isError,
        });

        // 明确选字段：terminate 是本次运行控制信息，不是模型历史。
        results.push({
            role: "toolResult",
            toolCallId: toolCall.id,
            content: result.content,
            isError,
            details: result.details,
        });
    }

    return {
        contexts,
        results,
        allTerminated: outcomes.length > 0 &&
            outcomes.every((result) => result.terminate === true),
    };
}
~~~

三个边界：

1. 普通工具异常：产生 isError=true，模型能看到错误并解释。
2. before 拒绝、查找失败、参数错误：没有执行工具，所以不调用 after。
3. 事件订阅异常：向上抛出，Run 失败。此时不承诺批次完整落盘；修复存储/订阅问题后重新打开会话检查，不能当成可恢复的普通工具错误。

取消是协作式的：Tool、Hook 必须使用 signal 才能及时停。不能强杀一个忽略 signal、永不返回的工具，也不回滚文件。

## 5. 把 after、signal、terminate 接到 Agent 与 Loop

### 5.1 src/agent.ts：四个插入点

在来自 ./types.ts 的 import type 列表加入 AfterToolCall。

在 AgentOptions 的 beforeToolCall 后加入：

~~~ts
afterToolCall?: AfterToolCall;
~~~

在 Agent 类的 beforeToolCall 字段后加入：

~~~ts
private readonly afterToolCall?: AfterToolCall;
~~~

在 constructor 的 this.beforeToolCall 赋值后加入：

~~~ts
this.afterToolCall = options.afterToolCall;
~~~

在 startRun 内 runAgentLoop 的配置对象中，beforeToolCall 后加入：

~~~ts
afterToolCall: this.afterToolCall,
~~~

不是加到 main 的局部变量里：调用方通过 AgentOptions 配置，Agent 保存，Loop 使用。

### 5.2 src/agent-loop.ts：类型和 runTurn 的四处修改

在 ./types.ts 的 import type 列表加入 AfterToolCall。
在 AgentLoopConfig 的 beforeToolCall 后加入：

~~~ts
afterToolCall?: AfterToolCall;
~~~

把 runTurn 的返回类型替换为：

~~~ts
async function runTurn(): Promise<{
    reply: AssistantMessage;
    toolResults: ToolResultMessage[];
    allTerminated: boolean;
}> {
~~~

这里只替换函数签名，保留下面模型请求部分。

找到原 const {results} = await executeTools(...)，将整个调用替换为：

~~~ts
const {results, allTerminated} = await executeTools(context.tools, reply, {
    beforeToolCall: config.beforeToolCall,
    afterToolCall: config.afterToolCall,
    signal: config.signal,
    emit,
});
~~~

后面的 appendAndEmitMessages(results)、turn_end 保留。将 runTurn 的最后一行替换为：

~~~ts
return {reply, toolResults: results, allTerminated};
~~~

### 5.3 整体替换外层 try 内的循环段

在 runAgentLoop 的 try 中，保留 agent_start、signal 检查和 maxTurns 校验。
从 let pendingMessages = [...initialMessages] 开始，一直到 return await finish("completed")，用下面整段替换。
后面的 catch 保持 Task 4 内容不变。

~~~ts
let pendingMessages = [...initialMessages];
let lastTurnTerminated = false;

do {
    config.signal?.throwIfAborted();
    await appendAndEmitMessages(pendingMessages);
    pendingMessages = [];

    while (true) {
        config.signal?.throwIfAborted();
        if (turn >= config.maxTurns) return await finish("max_turns");
        turn++;

        const {reply, toolResults, allTerminated} = await runTurn();
        lastTurnTerminated = allTerminated;
        // 先保存这一批的成功/失败/取消结果，再在边界退出。
        config.signal?.throwIfAborted();

        const shouldStop = await config.shouldStopAfterTurn?.({
            message: reply,
            toolResults,
            context,
            newMessages,
        }, config.signal);
        config.signal?.throwIfAborted();
        if (shouldStop) return await finish("terminated");

        const needsToolContinuation = toolResults.length > 0 && !allTerminated;
        if (turn >= config.maxTurns && needsToolContinuation) {
            return await finish("max_turns");
        }

        const steering = config.pollSteering?.() ?? [];
        if (steering.length > 0) {
            await appendAndEmitMessages(steering);
            continue;
        }

        if (needsToolContinuation) continue;
        break;
    }

    pendingMessages = config.pollFollowUp?.() ?? [];
} while (pendingMessages.length > 0);

return await finish(lastTurnTerminated ? "terminated" : "completed");
~~~

优先级准确含义：

- abort：结果批次收尾后退出。
- shouldStopAfterTurn：显式硬停止，队列留给后续 Run。
- 预算：需要自动工具续跑但已耗尽时 max_turns。
- steer：优先处理新方向；工具 terminate 不丢弃用户的新要求。
- 工具都 terminate：停止自动工具续跑，但仍允许 followUp。
- 没有后续输入：按最后一轮结果返回 terminated 或 completed。

terminate 不是权限系统。混合批次里一个 terminate、另一个不 terminate，仍会续跑；真正的安全限制必须每次由策略/文件边界强制执行。

## 6. 三个文件工具：替换 execute 方法

类名、constructor、parameters、resolvePath 和原有 import 不改。这三个方法没有进度需求，所以无需声明 onUpdate。

### 6.1 src/tools/read-file-tool.ts

~~~ts
async execute(args: ToolArguments, signal?: AbortSignal): Promise<ToolExecutionResult> {
    signal?.throwIfAborted();
    const path = args.path;
    if (typeof path !== "string") {
        throw new Error("read 工具缺少字符串类型的 path 参数");
    }
    const absolutePath = resolvePath(this.workspaceRoot, path);
    const content = await readFile(absolutePath, {encoding: "utf8", signal});
    signal?.throwIfAborted();
    return {content};
}
~~~

### 6.2 src/tools/write-file-tool.ts

~~~ts
async execute(args: ToolArguments, signal?: AbortSignal): Promise<ToolExecutionResult> {
    signal?.throwIfAborted();
    const path = args.path;
    const content = args.content;
    if (typeof path !== "string" || typeof content !== "string") {
        throw new Error("write 工具需要字符串类型的 path 和 content 参数");
    }
    const absolutePath = resolvePath(this.workspaceRoot, path);
    await writeFile(absolutePath, content, {encoding: "utf8", signal});
    signal?.throwIfAborted();
    return {content: "已写入 " + path + "（" + content.length + " 字符）"};
}
~~~

不顺手增加 mkdir 或覆盖确认，这些是另一项行为变更。write 的取消不保证磁盘完全没有写入。

### 6.3 src/tools/list-dir-tool.ts

~~~ts
async execute(args: ToolArguments, signal?: AbortSignal): Promise<ToolExecutionResult> {
    signal?.throwIfAborted();
    if (args.path !== undefined && typeof args.path !== "string") {
        throw new Error("listDir 的 path 必须是字符串");
    }
    const path = typeof args.path === "string" ? args.path : ".";
    const absolutePath = resolvePath(this.workspaceRoot, path);
    const entries = await readdir(absolutePath, {withFileTypes: true});
    // readdir 没有在这里传 signal；只能在操作前后响应取消。
    signal?.throwIfAborted();
    return {
        content: entries.map((entry) =>
            (entry.isDirectory() ? "[dir] " : "     ") + entry.name,
        ).join("\n") || "(空目录)",
    };
}
~~~

resolvePath 的现有字符串路径边界保持不变；它不等于能抵御符号链接/junction 的完整沙箱。

## 7. 新建 test/execute-tools.test.ts：完整文件

~~~ts
import assert from "node:assert/strict";
import test from "node:test";
import {executeTools} from "../src/execute-tools.ts";
import {validateToolArguments} from "../src/tool-arguments.ts";
import type {AgentEvent} from "../src/agent-events.ts";
import type {AssistantMessage, Tool} from "../src/types.ts";
import Agent from "../src/agent.ts";
import {FakeLlmClient} from "../src/fake-llm.ts";
import {MemorySessionStore} from "../src/session/memory-session-store.ts";

const reply: AssistantMessage = {
    role: "assistant", content: "",
    toolCalls: [{id: "c1", name: "echo", arguments: {text: "hello"}}],
};

function createTool(execute?: Tool["execute"]): Tool {
    return {
        name: "echo", description: "测试",
        parameters: {
            type: "object",
            properties: {text: {type: "string"}},
            required: ["text"],
            additionalProperties: false,
        },
        execute: execute ?? (async () => ({content: "ok"})),
    };
}

test("校验根节点、必填字段、类型和未知字段", () => {
    const tool = createTool();
    assert.throws(() => validateToolArguments(tool, null), /必须是 object/);
    assert.throws(() => validateToolArguments(tool, {}), /缺少参数：text/);
    assert.throws(() => validateToolArguments(tool, {text: 1}), /必须是 string/);
    assert.throws(() => validateToolArguments(tool, {text: "a", x: 1}), /未知参数/);
    assert.deepEqual(validateToolArguments(tool, {text: "a"}), {text: "a"});
});

test("参数错误和 before 拒绝都不会执行工具；block+terminate 生效", async () => {
    let executed = 0;
    let after = 0;
    const tool = createTool(async () => { executed++; return {content: "ok"}; });
    const invalid = structuredClone(reply);
    invalid.toolCalls![0]!.arguments = {};
    const first = await executeTools([tool], invalid);
    assert.equal(first.results[0]?.isError, true);

    const second = await executeTools([tool], reply, {
        beforeToolCall: async () => ({block: true, reason: "禁止", terminate: true}),
        afterToolCall: async () => { after++; return undefined; },
    });
    assert.equal(executed, 0);
    assert.equal(after, 0);
    assert.equal(second.allTerminated, true);
    assert.match(second.results[0]?.content ?? "", /禁止/);
    assert.equal(Object.hasOwn(second.results[0]!, "terminate"), false);
});

test("顺序为 start、before、execute、update、after、end", async () => {
    const trace: string[] = [];
    const tool = createTool(async (_args, _signal, onUpdate) => {
        trace.push("execute");
        await onUpdate?.({content: "50%"});
        return {content: "原结果"};
    });
    const result = await executeTools([tool], reply, {
        emit: async (event) => { trace.push(event.type); },
        beforeToolCall: async () => { trace.push("before"); return undefined; },
        afterToolCall: async ({isError}) => {
            assert.equal(isError, false);
            trace.push("after");
            return {result: {content: "脱敏结果", terminate: true}};
        },
    });
    assert.deepEqual(trace, [
        "tool_execution_start", "before", "execute",
        "tool_execution_update", "after", "tool_execution_end",
    ]);
    assert.equal(result.results[0]?.content, "脱敏结果");
    assert.equal(result.allTerminated, true);
});

test("execute 失败仍调用 after；after 也可转换错误", async () => {
    const result = await executeTools([
        createTool(async () => { throw new Error("敏感错误"); }),
    ], reply, {
        afterToolCall: async ({isError}) => {
            assert.equal(isError, true);
            return {result: {content: "已处理"}, isError: false};
        },
    });
    assert.equal(result.results[0]?.isError, false);
    assert.equal(result.results[0]?.content, "已处理");
});

test("after 抛错生成错误结果；未知工具不进入 after", async () => {
    const result = await executeTools([createTool()], reply, {
        afterToolCall: async () => { throw new Error("后处理失败"); },
    });
    assert.equal(result.results[0]?.isError, true);
    assert.match(result.results[0]?.content ?? "", /后处理失败/);
    let after = 0;
    await executeTools([], reply, {
        afterToolCall: async () => { after++; return undefined; },
    });
    assert.equal(after, 0);
});

test("取消后不执行剩余工具，但每个 call 都有一个结果", async () => {
    const controller = new AbortController();
    let executions = 0;
    const events: AgentEvent[] = [];
    const batch = structuredClone(reply);
    batch.toolCalls!.push({id: "c2", name: "echo", arguments: {text: "second"}});
    const tool = createTool(async (_args, signal) => {
        executions++;
        controller.abort();
        signal?.throwIfAborted();
        return {content: "不可达"};
    });
    const result = await executeTools([tool], batch, {
        signal: controller.signal,
        emit: (event) => { events.push(event); },
    });
    assert.equal(executions, 1);
    assert.deepEqual(result.results.map((item) => item.toolCallId), ["c1", "c2"]);
    assert.ok(result.results.every((item) => item.isError));
    assert.equal(events.filter((event) => event.type === "tool_execution_end").length, 2);
});

test("进度订阅失败不被吞成普通工具错误", async () => {
    await assert.rejects(executeTools([
        createTool(async (_args, _signal, onUpdate) => {
            await onUpdate?.({content: "进度"});
            return {content: "ok"};
        }),
    ], reply, {
        emit: (event) => {
            if (event.type === "tool_execution_update") throw new Error("订阅失败");
        },
    }), /订阅失败/);
});

test("空批次和混合 terminate 批次不算全部终止", async () => {
    assert.equal((await executeTools([], {role: "assistant", content: ""})).allTerminated, false);
    let count = 0;
    const batch = structuredClone(reply);
    batch.toolCalls!.push({id: "c2", name: "echo", arguments: {text: "b"}});
    const result = await executeTools([createTool(async () => ({
        content: "ok", terminate: ++count === 1,
    }))], batch);
    assert.equal(result.allTerminated, false);
});

test("Agent 贯通 before terminate 和 after，不再自动请求第二次模型", async () => {
    for (const mode of ["before", "after"] as const) {
        const llm = new FakeLlmClient([reply]);
        const agent = new Agent({
            llm,
            tools: [createTool()],
            sessionStore: new MemorySessionStore({id: mode, createdAt: 0}),
            beforeToolCall: mode === "before"
                ? async () => ({block: true, terminate: true})
                : undefined,
            afterToolCall: mode === "after"
                ? async () => ({result: {content: "完成", terminate: true}})
                : undefined,
        });
        const result = await agent.prompt("开始");
        assert.equal(result.reason, "terminated");
        assert.equal(llm.requests.length, 1);
        assert.equal(agent.state.pendingToolCalls.size, 0);
    }
});
~~~

最后一个测试按 Task 5 阶段保留 sessionStore；Task 6 会明确迁移此处。

## 8. 验证、断点与提交说明

在 package.json 的 scripts.test 字符串末尾追加一个空格和 test/execute-tools.test.ts，不删除原来的测试列表。

~~~powershell
npx tsx --test test/execute-tools.test.ts test/agent-control.test.ts test/agent-loop.test.ts test/agent.test.ts
npm run check
npm test
git diff --check
~~~

预期：新旧测试都通过，类型检查退出码 0。此处是实施后应运行的命令，不代表当前源码已通过。

| 断点 | 观察 |
|---|---|
| validateToolArguments | 模型 arguments 是实际对象，Schema 只是规则 |
| beforeToolCall 返回后 | block 决定是否执行，terminate 决定是否自动续跑 |
| tool.execute | 到这里才真正调用 Node 文件 API |
| afterToolCall | 收到结果与 isError，可替换，不再次执行工具 |
| results.push | 同一 toolCall.id 变为 toolCallId，terminate 被排除 |
| needsToolContinuation | Loop 决定是否再次请求模型 |

建议验证后自行提交：

~~~text
feat(agent): 完善工具校验、前后钩子、取消与终止流程
~~~

## 9. 通俗说明：这一层到底负责什么

~~~text
模型：我要 write(path, content)
  → executeTools：查找 + 校验 + before
  → WriteFileTool：writeFile 真正写磁盘
  → executeTools：after + tool_execution_end + ToolResultMessage
  → Loop：保存消息，决定继续请求模型还是终止
~~~

Tool 负责“干活”；executeTools 负责“安排、检查与汇报”；Loop 负责“下一步还做不做”。
onUpdate 是临时进度，不追加历史；最终 ToolResultMessage 才通过 message_end 保存。
