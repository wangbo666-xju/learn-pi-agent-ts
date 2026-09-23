# agent-ts

参考 Pi 核心设计手写的 TypeScript 学习版 Agent。目标是理解执行链路，不是复刻全部 Pi 功能或提供生产级安全平台。

## 启动与验证

开发环境：Node v24.13.0；TypeScript 与 tsx 使用项目锁文件中的版本。

配置环境变量：OPENAI_API_KEY、OPENAI_BASE_URL、OPENAI_MODEL。
BASE_URL 对应服务的 API 基础地址，RealLlmClient 会追加 /chat/completions。
密钥只在本机配置，不写入 Git、Session 或 Skill。

~~~powershell
npm ci --ignore-scripts
npm run dev
npm run check
npm test
~~~

IDEA 调试：Node 运行配置的 JavaScript 文件选择 node_modules/tsx/dist/cli.mjs，应用参数填 src/main.ts，工作目录为项目根目录。在该运行配置中设置环境变量。

## 结构

~~~text
CLI 命令 → Agent → Context transform/convert → LLM SSE
                → assistant(toolCalls) → executeTools
                → toolResult → 下一轮模型
AgentEvent → State 更新
           → SessionListener → JSONL
           → CLI Renderer → 流式显示
~~~

| 模块 | 职责 |
|---|---|
| agent.ts | 运行锁、队列、取消、继续、State 和事件 |
| agent-loop.ts | 双层循环、模型请求、工具批次、退出条件 |
| context.ts | 转换本次模型上下文，不改写 Session 历史 |
| real-llm.ts | HTTP/SSE 与模型协议适配 |
| execute-tools.ts | 查找、校验、before、execute、after、结果 |
| tools/ | read/write/listDir 的实际文件操作 |
| session/ | Store、SessionManager、事件持久化与恢复装配 |
| skills/ | Skill 扫描、索引、显式调用格式化 |
| cli-agent-runner.ts | 后台 Prompt 与交互控制 |
| cli-event-renderer.ts | 事件显示 |

## 运行语义

prompt 返回 AgentRunResult；完整历史看 state.messages。
maxTurns 计算一次 Run 的模型请求次数，steer/followUp 不重置预算。

steer：当前 Turn 完成后优先注入。
followUp：当前任务自然结束后处理。
abort：请求协作式取消，不撤销已完成的文件写入。
continue：从已有 user/toolResult 继续；assistant 结尾需要待处理队列。

工具执行顺序：

~~~text
start → 查找 → 参数校验 → before → execute/update → after → end → toolResult
~~~

普通工具错误回传模型；工具结果全部 terminate 时停止自动工具续跑。
shouldStopAfterTurn 是显式停止；terminate 不是替代权限校验的安全机制。

## Session 与 Skill

JSONL 第一行是 session header，后续每行是一条 message Entry，包含 id、seq、timestamp、message。
仅 message_end 保存 user/assistant/toolResult；partial 和工具进度不保存。
恢复时读取历史作为 initialMessages，不重发旧消息的保存事件。

自动 Skill 模式只提供名称、描述和路径，模型需要时调用 read 获取正文。
/skill:name 将完整正文和补充要求作为本轮输入。Skill 是指令，不是工具权限。

## CLI 命令

| 命令 | 作用 |
|---|---|
| /new | 新会话 |
| /sessions | 列会话 |
| /resume <id> | 恢复会话 |
| /skills | 列 Skill |
| /skill:<name> <要求> | 显式调用 Skill |
| /status | 查看运行状态 |
| /abort | 请求取消 |
| /steer <要求> | 改变当前任务方向 |
| /followup <要求> | 添加后续要求 |
| /help | 帮助 |
| /exit | 取消、等待并退出 |

运行中拒绝新 Prompt 和切换会话。exit 不带 / 时仍是普通文本。
/exit、输入结束以及可捕获的 SIGINT 会取消并等待清理。IDE 强制停止不能保证执行清理。
当前是普通 CLI，流式文字与正在输入的行可能视觉交错；尚未实现 TUI 输入区重绘。

## 当前限制

工具固定串行，Schema 只支持当前 object/string 子集。
路径限制是词法边界，不是抵御符号链接/junction 的完整沙箱。
JSONL 假定单写者，没有事务、崩溃修复和跨进程并发保证。
不提供 Compact、Session fork/lane/record、图片、thinking/usage、TUI、多 Provider 调度或遥测。

[开发任务](docs/task/00-INDEX.md) · [演进记录](docs/AGENT_EVOLUTION.md) · [验收记录](docs/ACCEPTANCE.md)
