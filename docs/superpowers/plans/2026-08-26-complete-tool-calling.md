# 补齐 Tool Calling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将当前“查找工具 → before → execute → 字符串结果”的实现补齐为可校验、可拦截、可收尾、可终止且错误可恢复的 Tool Calling 生命周期。

**Architecture:** `execute-tools.ts` 负责 `prepareToolCall → executePreparedToolCall → finalizeToolCall` 三阶段。工具只实现参数校验和真实执行；Agent 负责循环与停止原因；模型适配层保留原始工具参数，并将解析错误变成可交给工具执行层处理的数据。

**Tech Stack:** TypeScript、Node.js `node:test`、现有 `tsx`，不增加运行时依赖。

**Spec:** `docs/TODO.md`

## Global Constraints

- 本阶段保持工具串行执行，不实现并发调度。
- 不引入 Session、事件流、steer/followUp、TUI 或上下文压缩。
- 工具执行失败继续使用“抛异常，由执行层捕获”的约定。
- 每项行为必须先写失败测试，再写最小实现。
- 不调用真实模型 API；测试全部使用 `FakeLlmClient` 和测试工具。

---

## 文件职责

- `src/types.ts`：公开消息、工具、Hook、结构化结果和 Agent 停止协议。
- `src/execute-tools.ts`：工具调用的 prepare、execute、finalize 三阶段。
- `src/tool-call-parser.ts`：将 Provider 的工具参数 JSON 字符串安全转换为内部 `ToolCall`。
- `src/real-llm.ts`：HTTP/SSE Provider 适配，复用 `tool-call-parser.ts`，不再直接抛参数解析异常。
- `src/tool-policy.ts`：默认 before 策略，不负责真实文件写入。
- `src/tools/*.ts`：参数校验和真实文件操作。
- `src/agent.ts`：循环、最大轮数和结构化停止原因。
- `test/agent.test.ts`：Agent 与工具生命周期集成测试。
- `test/tool-call-parser.test.ts`：Provider 工具参数解析测试。

---

### Task 1: 引入结构化工具结果

**Files:**
- Modify: `src/types.ts`
- Modify: `src/execute-tools.ts`
- Modify: `src/tools/read-file-tool.ts`
- Modify: `src/tools/write-file-tool.ts`
- Modify: `src/tools/list-dir-tool.ts`
- Modify: `test/agent.test.ts`

**Interfaces:**
- Produces: `ToolExecutionResult`
- Produces: 带 `isError`、`details` 的 `ToolResultMessage`
- Changes: `Tool.execute()` 从 `Promise<string>` 改为 `Promise<ToolExecutionResult>`

- [ ] **Step 1: 修改成功和失败测试的预期结果**

```ts
assert.deepEqual(messages[2], {
    role: "toolResult",
    toolCallId: "call-1",
    content: "echo:hello",
    isError: false,
    details: undefined,
});
```

失败场景预期：

```ts
assert.deepEqual(messages[2], {
    role: "toolResult",
    toolCallId: "call-error",
    content: "工具执行失败: boom",
    isError: true,
    details: undefined,
});
```

- [ ] **Step 2: 运行测试，确认因为结果结构缺少字段而失败**

Run: `npm test`

Expected: FAIL，实际 `ToolResultMessage` 没有 `isError/details`。

- [ ] **Step 3: 在 `types.ts` 定义结构化结果**

```ts
export type ToolExecutionResult = {
    content: string;
    details?: unknown;
    terminate?: boolean;
};

export type ToolResultMessage = {
    role: "toolResult";
    toolCallId: string;
    content: string;
    isError: boolean;
    details?: unknown;
};

export interface Tool {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute(args: ToolArguments): Promise<ToolExecutionResult>;
}
```

`workspaceRoot` 从通用 `Tool` 接口移除，仍保留在三个文件工具类自己的字段中。

- [ ] **Step 4: 修改三个文件工具返回结构化结果**

`ReadFileTool.execute()`：

```ts
return {
    content: await readFile(absolutePath, "utf8"),
};
```

`WriteFileTool.execute()`：

```ts
await writeFile(absolutePath, content, "utf8");
return {
    content: `已写入 ${path}（${content.length} 字符）`,
};
```

`ListDirTool.execute()` 返回 `{content: formattedEntries}`。

- [ ] **Step 5: 修改测试工具的 `execute()` 返回类型**

```ts
async execute(args: ToolArguments): Promise<ToolExecutionResult> {
    // 失败仍然 throw
    return {content: `echo:${args.text}`};
}
```

- [ ] **Step 6: 运行测试和类型检查**

Run: `npm test`

Expected: PASS。

Run: `npm run check`

Expected: PASS。

---

### Task 2: 增加参数校验和 prepareToolCall

**Files:**
- Modify: `src/types.ts`
- Modify: `src/tools/read-file-tool.ts`
- Modify: `src/tools/write-file-tool.ts`
- Modify: `src/tools/list-dir-tool.ts`
- Modify: `src/execute-tools.ts`
- Modify: `src/tool-policy.ts`
- Modify: `test/agent.test.ts`

**Interfaces:**
- Consumes: `Tool.validateArguments(args)`
- Produces: `BeforeToolCallContext`
- Produces: `PreparedToolCall | ImmediateToolCallOutcome`

- [ ] **Step 1: 添加“参数失败时不调用 before 和 execute”的测试**

```ts
test("参数校验失败时不调用 beforeToolCall 和工具 execute", async () => {
    let beforeCalled = false;
    const before: BeforeToolCall = async () => {
        beforeCalled = true;
        return undefined;
    };
    const llm = new FakeLlmClient([
        {
            role: "assistant",
            content: "",
            toolCalls: [
                {id: "invalid", name: "echo", arguments: {text: 123}},
            ],
        },
        {role: "assistant", content: "已收到参数错误"},
    ]);
    const tool = new TestTool();
    const agent = new Agent(llm, [tool], before);

    const messages = await agent.prompt("调用参数错误的 echo");

    assert.equal(beforeCalled, false);
    assert.equal(tool.inputs.length, 0);
    assert.deepEqual(messages[2], {
        role: "toolResult",
        toolCallId: "invalid",
        content: "工具参数错误: echo 工具缺少字符串类型的 text 参数",
        isError: true,
        details: undefined,
    });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`

Expected: FAIL，当前 before 在工具内部参数校验之前执行。

- [ ] **Step 3: 定义校验后的 before 上下文**

```ts
export type BeforeToolCallContext = {
    toolCall: ToolCall;
    tool: Tool;
    args: ToolArguments;
};

export type BeforeToolCallResult = {
    block?: boolean;
    reason?: string;
    terminate?: boolean;
};

export type BeforeToolCall = (
    context: BeforeToolCallContext,
) => Promise<BeforeToolCallResult | undefined>;
```

- [ ] **Step 4: 将工具参数检查移入 `validateArguments()`**

`WriteFileTool` 示例：

```ts
validateArguments(args: ToolArguments): ToolArguments {
    if (typeof args.path !== "string" || typeof args.content !== "string") {
        throw new Error("write 工具需要字符串类型的 path 和 content 参数");
    }
    return args;
}
```

测试中的 `TestTool` 同样增加：

```ts
validateArguments(args: ToolArguments): ToolArguments {
    if (typeof args.text !== "string") {
        throw new Error("echo 工具缺少字符串类型的 text 参数");
    }
    return args;
}
```

`execute()` 只接收已经校验的参数，但仍保留必要的类型收窄，避免用类型断言跳过运行时安全。

- [ ] **Step 5: 在 `execute-tools.ts` 增加 prepare 联合类型**

```ts
type PreparedToolCall = {
    kind: "prepared";
    toolCall: ToolCall;
    tool: Tool;
    args: ToolArguments;
};

type ImmediateToolCallOutcome = {
    kind: "immediate";
    toolCall: ToolCall;
    result: ToolExecutionResult;
    isError: true;
};
```

`prepareToolCall()` 顺序必须固定为：

```text
查找工具
→ 检查 toolCall.argumentError
→ tool.validateArguments
→ beforeToolCall
→ 返回 prepared 或 immediate error
```

- [ ] **Step 6: 让 `tool-policy.ts` 使用上下文参数**

```ts
return async ({toolCall, args}) => {
    if (toolCall.name === "read" || toolCall.name === "listDir") {
        return undefined;
    }
    if (toolCall.name !== "write") {
        return {
            block: true,
            reason: `未配置工具策略：${toolCall.name}`,
        };
    }

    const path = args.path;
    if (typeof path !== "string") {
        return {block: true, reason: "write 工具缺少 path 参数"};
    }
    if (basename(path) === ".env") {
        return {block: true, reason: "禁止修改 .env 文件"};
    }
    if (!(await requestApproval(toolCall))) {
        return {block: true, reason: `用户拒绝写入文件：${path}`};
    }
    return undefined;
};
```

- [ ] **Step 7: 运行测试和类型检查**

Run: `npm test`

Expected: PASS。

Run: `npm run check`

Expected: PASS。

---

### Task 3: 拆分 execute/finalize 并实现 afterToolCall

**Files:**
- Modify: `src/types.ts`
- Modify: `src/execute-tools.ts`
- Modify: `test/agent.test.ts`

**Interfaces:**
- Produces: `AfterToolCallContext`
- Produces: `AfterToolCallResult`
- Produces: `executeTools(...): {contexts, results, terminate}`

- [ ] **Step 1: 添加 after 改写成功结果的测试**

```ts
test("afterToolCall 可以改写回传给模型的工具结果", async () => {
    const after: AfterToolCall = async ({result}) => ({
        content: `${result.content}[after]`,
    });
    const tool = new TestTool();
    const message: AssistantMessage = {
        role: "assistant",
        content: "",
        toolCalls: [
            {id: "after-success", name: "echo", arguments: {text: "hello"}},
        ],
    };

    const {results} = await executeTools([tool], message, allowAll, after);

    assert.deepEqual(results[0], {
        role: "toolResult",
        toolCallId: "after-success",
        content: "echo:hello[after]",
        isError: false,
        details: undefined,
    });
});
```

- [ ] **Step 2: 添加 after 改写错误状态的测试**

```ts
test("afterToolCall 可以处理工具抛出的错误结果", async () => {
    const after: AfterToolCall = async ({isError}) => ({
        content: isError ? "统一后的错误" : undefined,
        isError: true,
    });
    const tool = new TestTool("boom");
    const message: AssistantMessage = {
        role: "assistant",
        content: "",
        toolCalls: [
            {id: "after-error", name: "echo", arguments: {text: "hello"}},
        ],
    };

    const {results} = await executeTools([tool], message, allowAll, after);

    assert.equal(results[0]?.content, "统一后的错误");
    assert.equal(results[0]?.isError, true);
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npm test`

Expected: FAIL，当前没有 after hook。

- [ ] **Step 4: 定义 after 类型**

```ts
export type AfterToolCallContext = {
    toolCall: ToolCall;
    tool: Tool;
    args: ToolArguments;
    result: ToolExecutionResult;
    isError: boolean;
};

export type AfterToolCallResult = {
    content?: string;
    details?: unknown;
    isError?: boolean;
    terminate?: boolean;
};

export type AfterToolCall = (
    context: AfterToolCallContext,
) => Promise<AfterToolCallResult | undefined>;
```

- [ ] **Step 5: 拆出执行和收尾函数**

```ts
async function executePreparedToolCall(
    prepared: PreparedToolCall,
): Promise<{result: ToolExecutionResult; isError: boolean}>;

async function finalizeToolCall(
    prepared: PreparedToolCall,
    executed: {result: ToolExecutionResult; isError: boolean},
    afterToolCall?: AfterToolCall,
): Promise<{toolCall: ToolCall; result: ToolExecutionResult; isError: boolean}>;
```

`executeTools` 的签名同步改为：

```ts
export async function executeTools(
    tools: Tool[],
    message: AssistantMessage,
    beforeToolCall?: BeforeToolCall,
    afterToolCall?: AfterToolCall,
): Promise<{
    contexts: ToolRunContext[];
    results: ToolResultMessage[];
    terminate: boolean;
}>;
```

执行阶段只负责调用 `tool.execute()` 和捕获异常；收尾阶段按字段应用 after 覆盖。

- [ ] **Step 6: 扩展 `executeTools` 返回批次终止信号**

```ts
return {
    contexts,
    results,
    terminate:
        finalizedCalls.length > 0 &&
        finalizedCalls.every((call) => call.result.terminate === true),
};
```

只有整批调用都要求终止时才终止，保持与 pi 相同的批次语义。

- [ ] **Step 7: 运行测试和类型检查**

Run: `npm test`

Expected: PASS。

Run: `npm run check`

Expected: PASS。

---

### Task 4: 让策略拒绝和最大轮数优雅结束

**Files:**
- Modify: `src/types.ts`
- Modify: `src/agent.ts`
- Modify: `src/tool-policy.ts`
- Modify: `src/main.ts`
- Modify: `test/agent.test.ts`

**Interfaces:**
- Produces: `AgentOptions`
- Produces: `AgentRunResult`
- Changes: `Agent.prompt()` 返回 `Promise<AgentRunResult>`

- [ ] **Step 1: 添加策略终止测试**

```ts
test("beforeToolCall 要求 terminate 时不再请求模型", async () => {
    const llm = new FakeLlmClient([
        {
            role: "assistant",
            content: "",
            toolCalls: [
                {id: "blocked", name: "echo", arguments: {text: "hello"}},
            ],
        },
    ]);
    const tool = new TestTool();
    const agent = new Agent(llm, [tool], {
        beforeToolCall: async () => ({
            block: true,
            terminate: true,
            reason: "需要确认",
        }),
    });

    const result = await agent.prompt("调用受限工具");

    assert.equal(result.stopReason, "tool_terminated");
    assert.equal(llm.requests.length, 1);
    assert.equal(tool.inputs.length, 0);
});
```

- [ ] **Step 2: 添加最大轮数测试**

```ts
test("达到最大轮数时返回 max_turns 而不是抛异常", async () => {
    const llm = new FakeLlmClient([
        {
            role: "assistant",
            content: "",
            toolCalls: [
                {id: "turn-1", name: "echo", arguments: {text: "one"}},
            ],
        },
        {
            role: "assistant",
            content: "",
            toolCalls: [
                {id: "turn-2", name: "echo", arguments: {text: "two"}},
            ],
        },
    ]);
    const agent = new Agent(llm, [new TestTool()], {maxTurns: 2});

    const result = await agent.prompt("不断调用工具");

    assert.equal(result.stopReason, "max_turns");
    assert.equal(llm.requests.length, 2);
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npm test`

Expected: FAIL，当前策略不支持 terminate，最大轮数会 throw。

- [ ] **Step 4: 定义 Agent 运行协议**

```ts
export type AgentStopReason =
    | "completed"
    | "tool_terminated"
    | "max_turns";

export type AgentRunResult = {
    messages: AgentMessage[];
    stopReason: AgentStopReason;
};

export type AgentOptions = {
    maxTurns?: number;
    beforeToolCall?: BeforeToolCall;
    afterToolCall?: AfterToolCall;
};
```

- [ ] **Step 5: 修改 Agent 构造器和循环**

```ts
constructor(llm: LlmClient, tools: Tool[], options: AgentOptions = {}) {
    this.llm = llm;
    this.tools = tools;
    this.maxTurns = options.maxTurns ?? 10;
    this.beforeToolCall = options.beforeToolCall;
    this.afterToolCall = options.afterToolCall;
}
```

循环规则：

```text
无 toolCalls            → completed
executeTools.terminate  → tool_terminated
已经完成 maxTurns 轮    → max_turns
```

- [ ] **Step 6: 让 `.env` 拒绝结果携带 terminate**

```ts
return {
    block: true,
    terminate: true,
    reason: "写入 .env 需要用户明确确认",
};
```

- [ ] **Step 7: 更新 main 和现有测试读取 `result.messages`**

```ts
const result = await agent.prompt("...");
console.log(`停止原因：${result.stopReason}`);
```

`main.ts` 的构造方式改为：

```ts
const agent = new Agent(llm, tools, {
    beforeToolCall: policy,
});
```

- [ ] **Step 8: 运行测试和类型检查**

Run: `npm test`

Expected: PASS。

Run: `npm run check`

Expected: PASS。

---

### Task 5: 让非法 Provider 工具参数可恢复

**Files:**
- Create: `src/tool-call-parser.ts`
- Create: `test/tool-call-parser.test.ts`
- Modify: `src/types.ts`
- Modify: `src/real-llm.ts`
- Modify: `src/execute-tools.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `parseToolCall(id, name, rawArguments): ToolCall`
- Changes: `ToolCall` 保存 `rawArguments` 和可选 `argumentError`

- [ ] **Step 1: 写非法 JSON 的失败测试**

```ts
test("非法工具参数被记录为 argumentError 而不是抛异常", () => {
    const call = parseToolCall("call-1", "read", '{"path":');

    assert.equal(call.id, "call-1");
    assert.equal(call.name, "read");
    assert.deepEqual(call.arguments, {});
    assert.equal(call.rawArguments, '{"path":');
    assert.match(call.argumentError ?? "", /JSON/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`

Expected: FAIL，`tool-call-parser.ts` 尚不存在。

- [ ] **Step 3: 扩展 `ToolCall`**

```ts
export type ToolCall = {
    id: string;
    name: string;
    arguments: ToolArguments;
    rawArguments?: string;
    argumentError?: string;
};
```

- [ ] **Step 4: 实现纯解析函数**

```ts
export function parseToolCall(
    id: string,
    name: string,
    rawArguments: string,
): ToolCall {
    try {
        const value: unknown = JSON.parse(rawArguments);
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new Error("工具参数必须是 JSON 对象");
        }
        return {
            id,
            name,
            arguments: value as ToolArguments,
            rawArguments,
        };
    } catch (error) {
        return {
            id,
            name,
            arguments: {},
            rawArguments,
            argumentError: error instanceof Error ? error.message : String(error),
        };
    }
}
```

- [ ] **Step 5: real-llm 的流式和非流式路径统一调用 `parseToolCall()`**

`toApiMessages()` 回传 assistant 工具调用时使用：

```ts
arguments:
    toolCall.rawArguments ?? JSON.stringify(toolCall.arguments),
```

- [ ] **Step 6: prepare 阶段优先处理 `argumentError`**

```ts
if (toolCall.argumentError) {
    return createImmediateError(
        toolCall,
        `工具参数解析失败：${toolCall.argumentError}`,
    );
}
```

不得执行该工具，但错误必须作为 `toolResult` 回传模型。

- [ ] **Step 7: 将新测试文件加入 test script**

```json
"test": "tsx --test test/agent.test.ts test/tool-call-parser.test.ts"
```

- [ ] **Step 8: 运行测试和类型检查**

Run: `npm test`

Expected: PASS，所有测试均不访问真实 API。

Run: `npm run check`

Expected: PASS。

---

### Task 6: 更新学习文档并做最终验证

**Files:**
- Modify: `docs/AGENT_EVOLUTION.md`
- Modify: `docs/TODO.md`

**Interfaces:**
- Consumes: Tasks 1-5 的最终代码行为。
- Produces: 与当前实现一致的演进记录。

- [ ] **Step 1: 在演进文档增加“完整 Tool Calling 生命周期”**

必须记录：

```text
ToolCall
→ parse arguments
→ find tool
→ validate arguments
→ beforeToolCall
→ execute
→ afterToolCall
→ ToolResultMessage
→ terminate / next LLM turn
```

- [ ] **Step 2: 修正双层循环描述**

文档统一写为：

```text
内层：模型回复、工具调用、steering
外层：Agent 本来结束时检查 followUp
```

- [ ] **Step 3: 最终运行完整验证**

Run: `npm test`

Expected: 全部 PASS，0 failed。

Run: `npm run check`

Expected: PASS，无 TypeScript 错误。

Run: `git diff --check`

Expected: 无空白错误。

---

## 完成标准

完成本计划后，下列行为必须成立：

1. 工具不存在、参数非法、策略拒绝、工具异常都转成模型可读的 `toolResult`。
2. `beforeToolCall` 只接收校验后的参数。
3. `afterToolCall` 可以覆盖内容、详情、错误状态和终止状态。
4. 策略可要求 Agent 在本批工具结束后正常终止。
5. 达到最大轮数返回结构化停止原因，不抛出控制流异常。
6. Provider 返回残缺 JSON 时 Agent 不崩溃，也不执行残缺工具调用。
7. 全部行为由 Fake LLM 自动化测试覆盖。
