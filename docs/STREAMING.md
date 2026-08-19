# 流式传输设计笔记（streamText → chatStream）

> 本文件完整记录流式功能的设计思路与实现，覆盖 `src/real-llm.ts` 的
> `readSseChunks()` 共享核心，以及 `chat()`、`chatStream()`、`streamText()` 三个使用方，
> 并说明它们如何接入 `Agent.prompt()` 循环。
> 定位：把"为什么这么设计"讲清楚，而不只是逐行解释语法。

---

## 1. 设计目标：我们要解决什么问题

改造前，Agent 的交互模式是"**等完整回复，一次性打印**"：

```text
await llm.chat(messages, tools)      // 模型全部生成完才返回一个 JSON
console.log(reply.content)           // 然后整段一次性打印
```

缺点：用户在模型生成的那几秒里**什么都看不到**，只能干等；对工具调用这种"中间有停顿"的场景尤其难受。

设计目标：把交互改成"**模型说一个字，终端出一个字**"，同时**不破坏**已有的工具调用链路。

```text
[user]
→ [user, assistant(文本实时上屏, toolCall: read)]     ← 第一轮边生成边显示
→ [user, assistant, toolResult]                       ← 执行 read 工具
→ [user, assistant, toolResult, assistant(final)]     ← 第二轮同样边生成边显示
```

---

## 2. 总体设计：一个核心 + 三个使用方

流式解析本身和"拿到数据后怎么用"是两件事，所以拆成一层共享核心 + 三个使用方：

```text
                      readSseChunks(response, onChunk)
                     （只负责：字节 → SSE 帧 → 逐帧回调）
                          │  onChunk(帧JSON)
        ┌─────────────────┼──────────────────┐
        │                 │                  │
   chatStream()      streamText()        chat()
   （Agent 主路径）   （独立演示）       （非流式对照）
```

| 角色 | 代码 | 设计动机 |
|---|---|---|
| 共享核心 | `readSseChunks()` | "读流"的复杂逻辑只写一遍，三个使用方通过回调消费 |
| 使用方 A | `chatStream(messages, tools, onText)` | Agent 主路径：拼接文本 + 工具调用，返回完整 `AssistantMessage` |
| 使用方 B | `streamText(prompt)` | 独立演示：只把文本打终端，不关心工具调用 |
| 使用方 C | `chat(messages, tools)` | 非流式对照：一次性 JSON |

**核心取舍**：为什么不用一个函数 + 参数开关，而是拆三个？因为三个使用方的"返回约定"不同——`chat`/`chatStream` 要返回结构化 `AssistantMessage`，`streamText` 只负责打印（返回 `void`）。共用请求构造，但消费方式不同。

---

## 3. 网络层的"三层块"模型（读流最难的点）

流式传输的本质是：服务器把"一次完整回复"拆成"一长串增量"，经过三层不同粒度的"块"传回客户端。必须层层还原：

```text
网络层块（HTTP chunked，几 KB 字节，与内容无关）
   ↓ TextDecoder.decode(value, {stream: !done})
字符串片段（可能含 0~n 个换行符）
   ↓ buffer + split("\n")    再分帧
SSE 事件行（data: {...}，一帧 = 一次模型增量）
   ↓ JSON.parse + delta.content / delta.tool_calls
文字增量 / 工具参数碎片
   ↓ onText 回调 或 累加拼接
终端实时输出 / 完整 AssistantMessage
```

三个关键认知：

1. **`stream: true` 是唯一开关**（`chatStream` 请求体）：服务器行为由它决定，其余代码全是"读流"的机械活。
2. **`await fetch()` 不等 body**：拿到 `response` 时模型可能才刚吐出第一个字——这是流式成立的前提。
3. **网络块与 SSE 行不对齐**：一块字节里可能装好几行、也可能只装一行的前半截。所以必须有 `buffer` 缓存半行，等下一块补齐。

`readSseChunks()`（`real-llm.ts` 底部）的核心循环：

```ts
while (true) {
    const {value, done} = await reader.read();           // ① 异步等一块字节
    buffer += decoder.decode(value, {stream: !done});    // ② 字节→字符串，追加（防多字节乱码）
    const lines = buffer.split("\n");                    // ③ 按换行切
    buffer = lines.pop() ?? "";                          // ④ 最后一段可能是半行，留到下次
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) continue;         // 跳过空行/注释
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return;                // 协议层结束哨兵
        onChunk(JSON.parse(payload) as StreamChunk);     // 一帧 JSON 交给使用方
    }
    if (done) return;                                    // 传输层兜底退出
}
```

- **①** `await reader.read()` 挂起等数据——是"流"的驱动力。
- **②** `{stream: !done}`：中文等多字节字符可能被网络块劈成两半，靠它让解码器先缓存半截、下一块补齐。缺了会出乱码 `�`。
- **④** `lines.pop()`：网络块可能停在行中间，最后一段不是完整行，放回 buffer。
- **`[DONE]` 和 `done` 是双重保险**：一个来自协议层（SSE 结束标记），一个来自传输层（管道关闭）。

---

## 4. 关键设计决策

### 4.1 为什么 `chatStream` 返回与 `chat` 同构的 `AssistantMessage`

这是整个集成最关键的设计：`chatStream` 流结束后组装的返回结构，和 `chat` **完全一致**（`role: "assistant"`, `content`, `toolCalls?`）。因此：

> `Agent.prompt()` 的工具执行分支**一个字都不用改**——它只认 `AssistantMessage`，不关心这份回复来自流式还是非流式。

这让流式成为 `LlmClient` 的"另一种实现路径"，而不是侵入 Agent 循环的新机制。

### 4.2 文本增量：累加 + 实时回调

`chatStream` 里同时做两件事（`readSseChunks` 的回调内）：

```ts
if (delta.content) {
    content += delta.content;   // 累加，流结束 = 完整文本
    onText(delta.content);      // 实时回调，Agent 那边打印
}
```

- `content`：为返回的 `AssistantMessage.content` 服务（拼完整）。
- `onText`：为"边说边显示"服务（实时上屏）。

### 4.3 工具参数碎片拼接（最容易写错的地方）

流式协议里，`delta.tool_calls[].function.arguments` 是**一段段 JSON 字符串碎片**，
比如第一帧 `{"path":"Rea`，第二帧 `dme.md"}`。因此：

- **绝不可以逐帧 `JSON.parse`**（碎片不是合法 JSON，会抛错）。
- 必须**按 `index` 分组、字符串累加**，流结束再一次性 `parseToolArguments`。

```ts
// 按 index 分组累加
const toolCallFragments = new Map<number, {id; name; argumentsText}>();
for (const fragment of delta.tool_calls ?? []) {
    const index = fragment.index ?? 0;
    let acc = toolCallFragments.get(index);
    if (!acc) { acc = {...}; toolCallFragments.set(index, acc); }
    if (fragment.id) acc.id = fragment.id;
    if (fragment.function?.name) acc.name = fragment.function.name;
    if (fragment.function?.arguments) acc.argumentsText += fragment.function.arguments;  // 累加
}

// 流结束：按 index 排序，再 parse
const toolCalls = [...toolCallFragments.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, {id, name, argumentsText}]) => ({
        id, name,
        arguments: argumentsText ? parseToolArguments(argumentsText) : {},
    }));
```

设计要点：
- 用 `Map<index, 累加器>`：`index` 是"第几个工具调用"，模型一次可能发多个工具调用，靠它区分、保证组装顺序。
- `sort((a,b) => a[0]-b[0])` 按 index 排序，确保多个工具调用按声明顺序返回。

### 4.4 `onText` 回调 vs 直接打印

- `chatStream` 用 **`onText` 回调**：把"打印"这件事交给调用方（Agent）决定，`LlmClient` 不直接写终端——职责更清晰、可测试。
- `streamText` 用 **`process.stdout.write`**：独立演示，直接打。
- Agent 侧用 `process.stdout.write` 而不是 `console.log`：`write` 不换行、不缓冲，增量到了立刻上屏；`console.log` 自带换行会把流式效果破坏。

### 4.5 共享 helper：为什么抽出来

`requireConfig()`、`toApiMessages()`、`toApiTools()`、`parseToolArguments()` 从 `chat()` 里抽出，供三个方法复用，避免重复。其中：

- `requireConfig()`：读环境变量 + 判空，返回 `{apiKey, baseUrl, model}`，调用处用 `const {apiKey, baseUrl, model} = requireConfig()` 解构取回。
- `toApiMessages()` / `toApiTools()`：内部格式 → API 格式的转换（`toolResult`→`tool`、`Tool`→`{type:"function",...}`）。

---

## 5. Agent 循环集成

`Agent.prompt()`（`src/agent.ts`）只改了一处调用 + 一处打印：

```ts
while (true) {
    const reply = await this.llm.chatStream(messages, this.tools, (text) =>
        process.stdout.write(text),          // ← 文本增量实时上屏
    );
    messages.push(reply);

    if (!reply.toolCalls?.length) {
        if (reply.content) process.stdout.write("\n");   // 文本已实时打过，只补换行
        return messages;
    }
    // 工具执行分支：完全复用，未改动
}
```

- 文本在 `onText` 里已实时打印，所以去掉原来的 `console.log(reply.content)`，结束只补 `\n`，避免重复打印。
- 工具执行分支（找 tool → try/catch → push toolResult）零改动——得益于 4.1 的"返回同构"设计。

---

## 6. 验证方式

1. **类型检查**：IDEA 编辑器看报错，或命令行 `npx tsc --noEmit`。
2. **无 API 联调**：临时用 `FakeLlmClient` 跑 `Agent`，预期消息演进：
   `user → assistant(toolCall) → toolResult → assistant(final)`。
3. **真机验证**：`main.ts` 用 `RealLlmClient + ReadFileTool`，跑 `读取 Readme.md 并总结`。
   观察两点：① 回答是否逐字上屏（而非整句瞬间出现）；② 最终回答是否基于文件内容。

---

## 7. 已知问题 / 待办（当前实现的小坑）

- **`chat()` 笔误**：请求体里 `tools: toApiTools` 漏了 `(tools)`，传成了函数本身而非数组。非流式路径目前未使用所以未暴露；修复为 `toApiTools(tools)`。
- **两轮文本之间缺换行**：第一轮（伴随工具调用）的文本和第二轮最终回答会连在一起（如 `...about.Based on...`）。建议在 `agent.ts` 工具执行分支的 for 循环结束后补 `process.stdout.write("\n")`。
- **`agent.ts` 的 import**：`import {AgentMessage, LlmClient, Tool}` 全是类型，建议改 `import type {...}`（tsx 能跑，但 Node 原生 type-stripping 需要 `import type`）。另有未使用的 `import * as repl from "node:repl"` 可删。
- **`fake-llm.ts` 整体被注释掉了**：目前无法脱离真实 API 联调，需要时取消注释（其 `chatStream` 已实现）。

## 8. 下一步方向

- 流式请求支持**取消 / 超时**（`AbortController` 中断 fetch 流）。
- **多工具**并发/串行调度（当前 for 循环串行执行）。
- `steer()` / `followUp()` 双层循环（对齐 pi 完整架构）。
- `finish_reason` 的处理（当前靠 `[DONE]`/`done` 退出）。
- Session 持久化、上下文压缩。
