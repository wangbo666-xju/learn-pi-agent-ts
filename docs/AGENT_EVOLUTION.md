# 我的 TypeScript Agent 演进记录

## 目标

手写一个最小可运行的 Agent，用它理解 pi 中的 `agent-loop`、Tool Calling 和工具执行，而不是直接复刻完整框架。

当前运行方式：

```text
tsx src/main.ts
```

调试方式：IDEA 使用 Node.js 启动 `../node_modules/tsx/dist/cli.mjs`，入口参数为 `../src/main.ts`。

## 第一阶段：最小 Agent Loop

实现文件：`../src/agent.ts`

核心循环：

```text
添加 user 消息
  → 请求 LLM
  → 添加 assistant 消息
  → 有 toolCalls：执行工具、追加 toolResult、继续循环
  → 无 toolCalls：输出文本、结束循环
```

这对应 pi 的 `runLoop()` 内层循环，但当前只有单层 `while (true)`，没有 `steer`、`followUp` 和双层循环。

## 第二阶段：定义内部协议

实现文件：`../src/types.ts`

定义了三类会话消息：

```text
UserMessage       用户输入
AssistantMessage  模型回复，可能携带 toolCalls
ToolResultMessage 工具执行后的结果
```

以及两个关键接口：

```text
LlmClient  统一模型调用入口：chat(messages, tools)
Tool       工具协议：名称、说明、参数 schema、execute()
```

这里的类型是 Agent 内部协议，不绑定 DeepSeek 等具体模型供应商。

## 第三阶段：用 Fake LLM 调试闭环

实现文件：`../src/fake-llm.ts`

`FakeLlmClient` 固定模拟两轮回复：

```text
第一次：返回 read 工具调用
第二次：看到 toolResult 后，返回最终文本
```

作用：不依赖真实 API，也能稳定用断点观察 `messages` 如何变化。

调试时看到的消息演进：

```text
[user]
→ [user, assistant(toolCall: read)]
→ [user, assistant(toolCall: read), toolResult]
→ [user, assistant(toolCall: read), toolResult, assistant(final)]
```

## 第四阶段：执行真实 read 工具

实现文件：`../src/tools/read-file-tool.ts`

`ReadFileTool` 使用 Node.js 内置模块 `node:fs/promises` 的 `readFile()` 读取文本文件。

它同时提供工具 schema：

```text
parameters.type = object
properties.path.type = string
```

外层必须是 `object`，因为模型调用传入的是：

```json
{ "path": "README.md" }
```

## 第五阶段：接入 DeepSeek

实现文件：`../src/real-llm.ts`

`RealLlmClient` 使用原生 `fetch` 调用 DeepSeek 的 OpenAI 兼容接口：

```text
POST {OPENAI_BASE_URL}/chat/completions
```

配置从环境变量读取，不把 API Key 写入代码：

```text
OPENAI_API_KEY
OPENAI_BASE_URL=https://api.deepseek.com
OPENAI_MODEL=deepseek-chat
```

## 第六阶段：真实 Tool Calling

真实 Tool Calling 有两次模型请求：

```text
请求 1
  messages + tools schema
    → DeepSeek 返回 tool_calls(read)

本地执行
  Agent 找到 ReadFileTool
    → readFile(path)
    → 生成 toolResult

请求 2
  messages 包含 assistant tool_calls + toolResult
    → DeepSeek 根据文件内容生成最终回答
```

`ApiToolCall` 和 `ChatCompletionResponse` 只属于 DeepSeek HTTP 协议适配层：

```text
ChatCompletionResponse  整个 HTTP 响应
ApiToolCall             响应内的一次工具调用
ToolCall                Agent 内部统一的工具调用格式
```

`real-llm.ts` 负责双向转换：

```text
Tool → DeepSeek tools schema
DeepSeek tool_calls → ToolCall
AgentMessage → DeepSeek messages
```

## 当前已经具备的能力

```text
用户输入 → 真实 LLM → 本地读文件工具 → 工具结果回传 → 最终回答
```

已实现：

- 单层 Agent Loop
- DeepSeek 真实模型调用
- 单个 `read` 工具
- 工具 schema 下发
- `tool_calls` 参数解析
- `toolResult` 回传
- 工具执行异常转为 `toolResult` 错误
- IDEA 断点调试整条链路

## 当前边界

当前是学习版，尚未处理：

- 工具参数校验失败后自动回传错误
- 多工具并发/串行调度
- 流式文本与工具参数增量
- 取消信号与超时
- Session 持久化
- 上下文压缩
- `steer()` / `followUp()` 双层循环

## 第七阶段：工具错误回传

实现文件：`../src/agent.ts`

工具调用不再假设一定成功。执行 `tool.execute()` 时使用 `try / catch`：

```text
参数错误或 readFile 失败
  → catch 异常
  → 生成 toolResult 错误消息
  → 让模型根据错误重新决定下一步
```

已用不存在的 `not-exists.md` 验证：Node.js 抛出 `ENOENT` 后，Agent 没有退出；
它将错误写入 `toolResult`，DeepSeek 随后说明了文件不存在的原因，并正常结束。

这对应 pi 中 `executePreparedToolCall()` 捕获异常、`createErrorToolResult()` 生成模型可读错误的核心设计。

## 后续开发计划

当前已经完成流式输出、最大工具轮数、工具错误回传、`beforeToolCall` 策略以及 read/write/listDir 工具。
下一阶段不继续增加工具，而是让 Agent 具备可恢复的 Session，再加入 Skill。

### 阶段一：Session 数据结构与存储接口

新增：

```text
src/session/types.ts
src/session/session-store.ts
```

先定义 Session 元数据、消息 Entry 和存储接口。这个阶段只建立协议，不修改 Agent Loop。

验收标准：

```text
npx tsc --noEmit
```

### 阶段二：内存 Session

实现 `MemorySessionStore`，验证消息可以追加并按原顺序读回。先用内存实现调试，避免同时处理文件系统问题。

### 阶段三：Session 接入 Agent

`Agent.prompt()` 不再每次创建空消息数组，而是从 Session 读取历史；user、assistant 和 toolResult
在形成完整消息后写入 Session。流式 `text_delta` 不落库，只保存最终完整消息。

### 阶段四：JSONL 持久化

实现 `JsonlSessionStore`：第一行保存 header，后续每行保存一条 message Entry。使用追加写入，启动时逐行解析恢复。

### 阶段五：CLI 会话管理

实现 `SessionManager` 和三个命令：

```text
/new             新建空会话
/sessions        查看历史会话
/resume <id>     恢复历史会话
```

### 阶段六：Skill

实现 Skill 目录扫描、`SKILL.md` 读取和 `/skill:name` 显式调用。Skill 内容只负责向上下文注入规则，实际能力仍由 Tool 提供。

### 阶段七：上下文压缩

当消息超过 token 阈值时生成摘要，后续请求使用“摘要 + 最近消息”。压缩结果作为独立 Entry 持久化。

### 阶段八：高级 Session 与运行治理

最后再增加：

```text
parentId / Lane / fork
Record 与运行恢复
工具超时和 AbortSignal
afterToolCall
LLM 网络错误重试
TUI
```

完整顺序：

```text
Session 类型
→ MemorySessionStore
→ 接入 Agent 消息流
→ JsonlSessionStore
→ 恢复历史
→ /new、/sessions、/resume
→ SkillLoader
→ /skill:name
→ Compact
→ Lane / fork / Record
→ TUI
```
