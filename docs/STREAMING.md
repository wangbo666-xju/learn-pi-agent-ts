# streamText 流式传输研究笔记

> 研究对象：`../src/real-llm.ts` 中的 `streamText()` 方法（第 128–201 行）。
> 本文从 **网络层（数据怎么传）** 和 **程序层（代码怎么读）** 两个视角，总结流式传输的完整机制。

---

## 1. 一句话总览

`streamText` 做的事情是：**发起一次"流式" HTTP 请求，然后像读水管一样，把服务器边生成边吐出来的文字增量，一点一点实时打印到终端**，而不是像 `chat()` 那样憋一整段 JSON、等回复完整后才一次性返回。

```text
用户输入 → fetch(stream: true) → 服务器边生成边推送
        → 客户端逐块拉取字节 → 还原成文字增量 → 实时打印到终端
```

---

## 2. 整体结构

代码只干三件事，对应三个层次：

| 层 | 关键代码 | 职责 |
|---|---|---|
| ① 发起流式请求 | `fetch(..., stream: true)` | 告诉服务器"生成一点发一点，别攒着" |
| ② 按网络块拉取字节 | `response.body.getReader()` + `reader.read()` | 底层水管是字节流，一块一块拿 |
| ③ 拆成 SSE 事件取增量 | buffer 缓冲 + 按行解析 + `delta.content` | 把字节还原成模型吐出的文字增量，立即输出 |

---

## 3. 网络层：数据是怎么"流"起来的

### 3.1 普通请求 vs 流式请求

- **普通 `chat()`**：POST 发出去，服务器等全部内容生成完，一次性返回完整 JSON（"点菜等上齐"）。
- **流式请求**：唯一的开关是 body 里的 `stream: true`。服务器收到后不走"等全部生成完"的路，而是**一边生成一边往 HTTP 响应里写**（"水管直接接灶台"）。

这也是为什么代码里必须检查 `response.body`（第 159 行）：

```ts
if (!response.body) throw new Error("模型响应没有流内容");
```

非流式响应可以没有 body（一次 JSON 全给了）；**流式响应必须靠 body 一点一点传**，所以必须检查。

### 3.2 底层传输：HTTP 分块传输编码（chunked transfer-encoding）

服务器无法预先告诉客户端"响应总共多少字节"（因为还没生成完），所以 HTTP 层使用：

```text
Transfer-Encoding: chunked
```

响应按"块"发送，每块前面标注长度，发完为止。这是**第一层分块：网络层的块**。

### 3.3 数据格式：SSE（Server-Sent Events）

在 chunked 之上，内容按 SSE 协议组织，格式极简：

- 每个事件一行，格式：`data: <json>`
- 空行分隔事件
- 流以 `data: [DONE]` 收尾

DeepSeek 实际返回的流（OpenAI 兼容格式）长这样：

```text
data: {"id":"chatcmpl-xxx","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","choices":[{"index":0,"delta":{"content":"用"},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","choices":[{"index":0,"delta":{"content":"10"},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","choices":[{"index":0,"delta":{"content":"句话"},"finish_reason":null}]}
   ...（很多帧，每帧只有一点点）
data: {"id":"chatcmpl-xxx","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

**关键概念：`delta.content` 是"增量"而不是"累计"**——每帧只包含新吐出来的那一点点（可能就一个字）。客户端把各帧的 `delta` 逐个拼起来，才是完整回复。这就是**第二层分块：SSE 事件层**，按换行符 `\n` 分隔。

### 3.4 客户端如何"读水管"

Node 的 `fetch` 返回的 `response.body` 是一个 `ReadableStream`（异步迭代的字节管道）：

```ts
const reader = response.body.getReader();    // 拿一个"拉取器"
const {value, done} = await reader.read();   // 每次 read() 异步等一块字节
```

- `value`：一块 `Uint8Array`（字节数组，大小不定）
- `done`：水管是否关闭

**核心难点**：网络层的一块与 SSE 的一行**没有任何对齐关系**——一块里可能装了好几行，也可能只装了一行的前半截。这是整个程序最绕的地方，也是 buffer 存在的理由。

---

## 4. 程序层：代码逐段拆解

### 4.1 入口与环境变量检查（L128–135）

```ts
async streamText(prompt: string): Promise<void> {
    const apiKey = process.env.OPENAI_API_KEY;
    const baseUrl = process.env.OPENAI_BASE_URL;
    const model = process.env.OPENAI_MODEL;
    if (!apiKey || !baseUrl || !model) throw new Error("缺少模型配置");
```

- 返回 `Promise<void>`：函数**不返回值**，文字直接写到终端（stdout），调用方拿不到结果。
- 三个环境变量缺一不可，防呆检查。

### 4.2 发起流式请求（L137–153）

```ts
const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
        model,
        stream: true,          // ← 灵魂所在：声明要流式
        messages: [{ role: "user", content: prompt }],
    }),
});
```

- 相比 `chat()`，多了 `stream: true`，且**不带 `tools`**——目前只是"裸文本流"，不参与工具调用。
- 重要细节：`await fetch()` **只等到响应头到达就返回**，不会等整个 body 传完。拿到 `response` 时，服务器可能才刚吐出第一个字——这是流式成立的前提。

### 4.3 拿到字节流读取器（L155–164）

```ts
if (!response.ok) throw ...
if (!response.body) throw new Error("模型响应没有流内容");

const reader = response.body.getReader();   // 字节管道的拉取器
const decoder = new TextDecoder();          // 字节 → 字符串 的翻译器
let buffer = "";                            // 半行残料的临时存放处
```

`reader.read()` 给的是**字节**，而我们要处理的是**字符串**，所以需要 `TextDecoder` 做翻译。

### 4.4 主循环：拉块 → 拼字符串 → 切行（L168–174）

```ts
while (true) {
    const {value, done} = await reader.read();          // ① 异步等一块字节

    buffer += decoder.decode(value, {stream: !done});   // ② 字节转字符串，追加到 buffer

    const lines = buffer.split("\n");                   // ③ 按换行切
    buffer = lines.pop() ?? "";                         // ④ 最后一段不一定是完整行，留到下次
```

这是全函数最核心的 4 行：

- **①** `await reader.read()`：挂起，等网络送来下一块字节。水管没数据时就等着，有数据才继续——**这是"流"的驱动力**。
- **②** `decoder.decode(value, {stream: !done})`：
  - 把字节翻译成字符串，**追加**到 `buffer`（不是覆盖，因为上一轮可能留了半行）。
  - `stream: !done` 告诉解码器"后面可能还有数据"。这样遇到**多字节字符被网络块从中间劈开**的情况（如中文"句"是 3 个 UTF-8 字节，可能第 2 字节在这块、第 3 字节在下一块），解码器会先把半截字符**缓存在自己内部**，等下一块字节到了再拼好。没有这个参数就会解出乱码（`�`）。
- **③** 按 `\n` 切行：换行符正是 SSE 的事件分隔符。
- **④** `lines.pop()`：**最后一段不一定是完整的一行**——网络块可能在行中间戛然而止。所以把最后一段放回 buffer 存着，等下一块字节来了接着拼。

> 一轮循环里可能拿到 0 个完整行（全是半截），也可能拿到几十个完整行——取决于网络块怎么切。

### 4.5 逐行解析 SSE 事件（L176–194）

```ts
for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;    // 跳过空行和注释行

    const payload = line.slice(5).trim();       // 去掉 "data:" 前缀

    if (payload === "[DONE]") return;           // SSE 结束哨兵 → 直接收工

    const chunk = JSON.parse(payload) as StreamChunk;   // 每帧是一个 JSON
    const text = chunk.choices[0]?.delta.content;       // 取增量文本

    if (text) process.stdout.write(text);       // 立即打印，不换行
}
```

- `if (!line.startsWith("data:")) continue`：SSE 协议中 `:` 开头的行是注释、空行是事件分隔符，没有有效载荷，跳过。
- `line.slice(5)`：砍掉 `data:` 这 5 个字符。
- `[DONE]`：服务器说"发完了"，直接 `return` 退出整个函数。
- 每帧只取 `choices[0].delta.content`——即增量文字。
- `if (text)`：有的帧 `delta` 是空的（如最后一个 `finish_reason: "stop"` 帧），没有文本就不输出。

### 4.6 兜底退出（L197–199）

```ts
if (done) return;
```

如果服务器没发 `[DONE]` 就断流（超时、网络中断等），`reader.read()` 会返回 `done: true`，从这里兜底退出。

---

## 5. 三层"块"的对应关系（全函数最难理解的点）

整个函数在和**三种粒度完全不同**的"块"打交道，必须层层还原：

```text
网络层块（chunked，几 KB 字节，与内容无关）
   ↓ TextDecoder 解码
字符串片段（可能含 0~n 个换行）
   ↓ buffer + split("\n")
SSE 事件行（data: {...}，一帧 = 一次模型增量）
   ↓ JSON.parse + delta.content
文字增量（可能就 1~2 个字）
   ↓ process.stdout.write
终端屏幕上实时蹦出来的字
```

- **网络层块** 与 **SSE 行** 不对齐 → 所以需要 `buffer` + `split` 做"再分帧"；
- **SSE 帧** 与 **语义文字** 不对齐（一帧可能是半个词）→ 客户端从不"理解"内容，只是无脑拼接 `delta`；
- 拼接全部 `delta` 才是完整回复，但 `streamText` 从不拼接——它**只要即时打印**，所以用 `process.stdout.write`（不换行、不缓冲）而不是 `console.log`（自带换行和缓冲）。

---

## 6. 关键设计点汇总

1. **`stream: true` 是唯一开关**：服务器行为由它决定，其余代码全是"读流"的机械活。
2. **`await fetch()` 不等 body**：拿到 `response` 时内容才开始来，这是流式与"等全部"的分水岭。
3. **`{stream: !done}` 防乱码**：中文等多字节字符跨网络块时靠它兜底。
4. **`[DONE]` 与 `done` 是双重保险**：一个来自协议层（SSE 结束哨兵），一个来自传输层（管道关闭）。
5. **流式也可以带工具**：OpenAI 兼容协议中，工具调用的流式形式是 `delta.tool_calls`（`function.arguments` 也是一段段增量字符串）。当前 `streamText` 只处理 `delta.content`，与 Agent 的 tool-calling 循环是脱节的。

---

## 7. 与 `chat()` 的对比

| | `chat()` | `streamText()` |
|---|---|---|
| 请求 | 不带 `stream` | `stream: true` |
| 响应 | 一次性完整 JSON | SSE 字节流 |
| 拿到结果的时间 | 等模型全部生成完 | 生成第一个字就开始 |
| 返回 | `AssistantMessage`（结构化） | `void`（直接打终端） |
| 用途 | Agent 循环的核心 | 目前是独立演示用 |

**一句话理解整个机制**：`stream: true` 让服务器把"一次完整的回复"改造成"一长串增量事件"；客户端用 `getReader()` 拉字节、用 `TextDecoder` 还原字符串、用 buffer 对齐行边界、用 `JSON.parse` 取 `delta.content`，最后 `write` 出去——四层还原，换来的是"第一个字几乎零延迟上屏"。

---

## 8. 局限与下一步

当前 `streamText` 的边界（对应 `AGENT_EVOLUTION.md` 中"下一步"）：

- 只处理 `delta.content`，**未处理 `delta.tool_calls` 增量拼接**——真正接入 Agent 循环时，需要收集 `function.arguments` 片段，流结束后组装完整 JSON 再执行工具；
- 未处理 `finish_reason`（当前靠 `[DONE]`/`done` 退出）；
- 未处理 `role` 首帧之外的其他增量字段；
- 流式输出与 `Agent.prompt()` 循环完全独立，尚未打通"边说边显示 + 工具调用"的完整链路。
