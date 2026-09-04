# Pi Agent 学习版设计

## 1. 项目目标

在现有代码上完成一个 Pi 风格的学习版 Agent：保留清晰的调用链，覆盖 Agent 的核心能力，但不复制 Pi 的全部生产级工程设施。

最终需要具备：

```text
流式模型调用
+ Tool Calling
+ Agent 状态与生命周期事件
+ abort / continue / waitForIdle
+ steer / followUp 双层循环
+ Session 持久化与恢复
+ Skill 自动发现与显式调用
```

## 2. 当前基础

已经完成：

- 单层 Agent Loop：模型返回工具调用后，执行工具并继续请求模型。
- OpenAI 兼容模型适配：支持 DeepSeek、SSE 文本流和工具参数碎片组装。
- 工具执行：`read`、`write`、`listDir`、工作区路径保护、`beforeToolCall`。
- Session：内存存储、JSONL 存储、创建、列举和恢复。
- Skill：扫描 `SKILL.md`、生成 System Prompt 索引、`/skill:<name>` 显式调用。
- CLI：普通输入以及 `/new`、`/sessions`、`/resume`、`/skills` 等命令。
- 自动化测试：Agent、Session、Skill、模型请求和 CLI 错误处理。

当前主要问题不是缺少外围功能，而是缺少统一的 Agent 运行时：状态分散、SSE 直接打印、没有运行控制，Session 保存也写在 Loop 中。

## 3. 范围

### 本次实现

- `AgentState`：集中保存消息、流式消息、运行状态和工具状态。
- `AgentEvent`：统一输出消息、工具和 Turn 生命周期。
- `Agent`：作为公开控制器，提供 `prompt()`、`continue()`、`abort()`、`waitForIdle()`、`reset()`。
- 双层 Loop：工具循环、steer 优先队列和 followUp 后续队列。
- Context 管线：`transformContext()` 后调用 `convertToLlm()`。
- 工具管线：参数校验、`beforeToolCall`、执行、`afterToolCall`、`terminate`。
- Session 集成：完整消息在 `message_end` 时落盘。
- CLI 演示：显示事件，并提供 steer、follow-up、abort 和 status 命令。

### 暂不实现

- Session Tree、Lane、Record 和分支摘要。
- SQLite、数据库或远程 Session Backend。
- 多模型注册中心和动态 OAuth。
- 完整 TUI、浏览器运行时和 Provider Proxy。
- 遥测平台、计费、指标上报。
- 完整 JSON Schema 标准；学习版只校验当前工具使用的对象、必填字段和基础字段类型。
- 并行工具调度；第一版继续使用顺序执行，保证调用链容易调试。

## 4. 设计原则

### 4.1 保留现有模块，不推倒重写

现有 `RealLlmClient`、工具、Session 和 Skill 都继续使用。重构重点是把职责移动到正确边界，而不是更换所有接口。

### 4.2 Agent 负责控制，Loop 负责执行

- `Agent` 管理状态、队列、订阅者和当前运行。
- `agent-loop` 只执行一轮轮模型与工具调用，并发出事件。
- CLI 不直接操作消息数组，也不参与工具执行。

### 4.3 模型适配器不负责 UI

`RealLlmClient` 只把 SSE 转换成语义事件，不调用 `process.stdout.write()`。终端输出由 CLI 订阅 `AgentEvent` 后完成。

### 4.4 内存状态和持久化记录分离

- `AgentState.messages` 是当前运行上下文。
- `SessionStore` 是已经完成消息的持久化记录。
- partial assistant 消息只存在于 `streamingMessage`。
- Loop 只在消息完整时把它加入 `context.messages`，并发布 `message_end`。
- Session 监听器收到 `message_end` 后才持久化该完整消息。

### 4.5 错误也必须保持协议完整

单个工具失败不能打断 Agent Loop，而要转换成 `isError: true` 的 `toolResult`。模型请求失败和主动中止则结束当前 Run，并通过 `agent_end` 给出明确原因。

## 5. 总体结构

```text
CLI
 │  prompt / steer / followUp / abort
 ▼
Agent（公开控制器）
 ├─ AgentState
 ├─ Event Subscribers
 ├─ SteeringQueue / FollowUpQueue
 └─ activeRun + idlePromise + AbortController
          │
          ▼
      agent-loop
       ├─ transformContext
       ├─ convertToLlm
       ├─ LlmClient.chatStream
       └─ executeTools
             ├─ validate
             ├─ beforeToolCall
             ├─ Tool.execute
             ├─ afterToolCall
             └─ ToolResultMessage

message_end ──► SessionStore.appendMessage

SkillLoader ──► System Prompt Skill 索引
/skill:name ──► 完整 Skill 作为本轮用户消息
```

## 6. 模块设计总结

| 模块 | 主要职责 | 不应该负责 |
|---|---|---|
| `agent.ts` | 公开 API、运行互斥、队列、取消、订阅、状态更新 | SSE 解析、文件读写 |
| `agent-loop.ts` | Turn 循环、双层调度、调用模型和工具 | CLI 输出、Session 文件格式 |
| `agent-state.ts` | 保存当前消息、partial 消息、运行状态和错误 | 执行模型请求 |
| `agent-events.ts` | 定义事件类型和事件监听协议 | 保存消息 |
| `message-queue.ts` | 保存、读取和清空 steer/followUp 消息 | 判断模型结果 |
| `context.ts` | `transformContext` 和 `convertToLlm` | Provider HTTP 转换 |
| `real-llm.ts` | HTTP、SSE、API 消息转换、工具参数碎片组装 | 打印终端、持久化 Session |
| `execute-tools.ts` | 工具准备、校验、前后 Hook、执行和结果转换 | 决定下一轮 Prompt |
| `tools/` | 单个外部动作 | Agent 状态和 Session 管理 |
| `session/` | 完整消息的追加、读取、会话创建与恢复 | partial 流式状态 |
| `skills/` | Skill 发现、索引和显式注入 | 实际执行文件操作 |
| `cli-command.ts` | 把字符串解析成 CLI 命令 | 执行 Agent 逻辑 |
| `main.ts` | 组装依赖、订阅事件和路由 CLI 命令 | 实现 Agent Loop |

## 7. 核心状态

```ts
export type AgentState = {
    systemPrompt: string;
    messages: AgentMessage[];
    tools: Tool[];
    isRunning: boolean;
    streamingMessage?: AssistantMessage;
    pendingToolCalls: ReadonlySet<string>;
    errorMessage?: string;
};
```

`SessionStore` 不代替 `AgentState`：Session 负责跨进程恢复，State 负责当前进程中的实时运行状态。

## 8. 事件协议

最小事件集合：

```text
agent_start
turn_start
message_start
message_update
message_end
tool_execution_start
tool_execution_update
tool_execution_end
turn_end
agent_end
```

主要顺序：

```text
agent_start
  message_start(user)
  message_end(user)
  turn_start
    message_start(assistant partial)
    message_update(...)
    message_end(assistant complete)
    tool_execution_start
    tool_execution_update(...)
    tool_execution_end
    message_start(toolResult)
    message_end(toolResult)
  turn_end
agent_end
```

订阅者按注册顺序等待执行完成。这样 `message_end` 的 Session 保存可以作为进入下一阶段之前的屏障。若监听器失败，Loop 进入统一错误收尾并仍发布一次 `agent_end`。

消息和实时字段的所有权不同：Loop 负责向传入的 `context.messages` 追加完整消息；`Agent.applyEvent()` 只维护 `isRunning`、`streamingMessage`、`pendingToolCalls` 和错误状态，不重复追加 transcript。

## 9. Context 管线

```text
AgentState.messages
  ↓
transformContext(messages, signal)
  ↓
convertToLlm(messages)
  ↓
LlmClient.chatStream(llmMessages)
```

- `transformContext`：以后承载裁剪、Compact 和外部上下文注入；第一版默认原样返回。
- `convertToLlm`：过滤模型不认识的应用消息；第一版只保留 `user`、`assistant`、`toolResult`。
- `RealLlmClient`：继续负责把统一 LLM 消息转换为 OpenAI 兼容 JSON。

## 10. 双层 Loop

```text
外层循环：处理一次初始任务或一个 followUp
  │
  └─ 内层循环：
       调用模型
       → 执行本轮全部工具
       → 发出 turn_end
       → shouldStopAfterTurn 为 true：结束
       → 有 steer：优先注入 steer，继续内层循环
       → 有未终止工具结果：继续内层循环
       → 否则退出内层循环

退出内层循环后：
  → 有 followUp：作为下一次外层输入
  → 没有 followUp：结束 Agent Run
```

优先级固定为：

```text
abort / maxTurns
→ shouldStopAfterTurn
→ steer
→ 未终止工具结果触发的自动下一轮
→ followUp
→ terminated / 正常结束
```

## 11. Session 集成

Session 使用现有 JSONL 格式，不修改历史文件结构。

```text
message_start   → 只更新 AgentState
message_update  → 根据 text_delta/toolcall_delta 替换 streamingMessage
message_end     → Loop 已追加 context.messages；Session 监听器 appendMessage()
agent_end       → 清理 isRunning、streamingMessage 和 pendingToolCalls
```

恢复会话时：

```text
SessionManager.open(id)
→ SessionStore.getMessages()
→ 创建 AgentState.messages
→ 用户可以 prompt() 或 continue()
```

## 12. Skill 集成

保留现有渐进式披露设计：

```text
启动时扫描 skills/*/SKILL.md
→ System Prompt 只注入 name、description、location
→ 模型匹配后使用 read 工具读取完整内容
```

显式调用继续使用：

```text
/skill:<name> <补充要求>
→ formatSkillInvocation()
→ Agent.prompt()
→ 完整 Skill 内容进入 Session
```

第一版不做 Skill 热加载和安装功能。

## 13. 完成标准

满足以下场景即可认为学习版 Agent 完成：

1. 普通文本能流式输出，状态中可以看到 partial assistant 消息。
2. 工具调用产生完整的 start、update、end 事件和 `toolResult`。
3. 工具失败、参数错误和 Hook 拦截都能回传给模型；`terminate` 只控制运行，不污染持久化消息。
4. 运行时可以 `abort()`，调用方可以 `waitForIdle()`。
5. 失败后可以使用 `continue()` 从现有上下文继续。
6. 运行期间 `steer()` 优先生效，结束后 `followUp()` 生效。
7. `/new` 和 `/resume` 的消息互不混合，重新启动后可以恢复。
8. Skill 可以自动暴露索引，也可以通过 `/skill:name` 显式调用。
9. Agent Core 不直接打印终端，也不直接使用 Node 文件 API。
10. `npm test` 和 `npx tsc --noEmit` 全部通过。

完成以上内容后，Session Tree、Compact、并行工具、图片、Thinking 和 TUI 都属于后续扩展，不影响本阶段收尾。
