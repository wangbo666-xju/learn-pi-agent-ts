# 学习版 Agent 验收记录

## 环境

| 项目 | 记录 |
|---|---|
| 日期 | 2026-09-21 |
| Node | v24.13.0 |
| 基线提交 | 15cc6d1 refactor(agent): 通过事件订阅持久化完整会话消息 |
| 工作区 | 本次 07/08 修改未提交；测试针对工作区代码 |
| 模型 | 自动测试使用 Fake LLM、本地模拟 HTTP/SSE；未调用付费服务 |

## 自动化证据

| 检查 | 结果 |
|---|---|
| npm test | 73 passed，0 failed，0 cancelled，0 skipped |
| npm run check | 通过 |
| Node strip-only 导入核心、Session 工厂、CLI Runner/Renderer | 通过 |
| git diff --check | 通过；Git 的 LF/CRLF 提示不属于空白错误 |

组合测试覆盖工具进度、steer 优先于 followUp、完整消息持久化、Skill 显式调用，以及 completed/aborted/max_turns/terminated/error 五种结束分支。
CLI Runner 测试额外覆盖 agent_end 已发出但监听器尚未完成的收尾窗口，此时不能切换会话。

cli-process.test.ts 在临时目录复制源码并启动真实 Node CLI，使用本地 SSE 服务：
- 网络流等待期间能输入 /status，运行中 /new 被拒绝。
- /exit 与输入 EOF 均取消网络请求、完成收尾，并以退出码 0 退出。
- Windows 通过测试专用 IPC 触发 process SIGINT 事件，验证进程信号处理器；这不等同于实测 IDEA 的 Ctrl+C 按键。
- 测试不写项目 sessions，结束后清理各自临时目录。

## 真实模型手工验收

| 场景 | 状态 |
|---|---|
| 真实服务流式回答、read/write、越界拒绝 | 未执行 |
| 实际终端 status/steer/followup/abort 与输入显示 | 未执行 |
| 运行中切会话拒绝、new/resume 历史隔离与恢复 | 自动化覆盖相关逻辑；CLI 手工待执行 |
| Skill 显式调用与模型主动 read SKILL.md | 显式装配自动化通过；真实模型待执行 |
| 实际终端 /exit、Ctrl+C | 子进程自动化通过；实际按键待执行 |

按 docs/task/08-FINAL-ACCEPTANCE.md 第 4 节逐项验证后更新本表。
IDE 强制终止或操作系统强杀无法保证 finally 执行。

## 实施记录

- Task 07：已完成 CLI 后台运行、控制命令、独立渲染器、会话切换保护及退出清理。
- Task 08：已完成组合测试、测试列表对账、README、演进记录和索引更新；手工验收保留待执行。
- 初次新增测试确认缺少 /status、Renderer、Runner；实现后通过。
- 独立审查发现非 TTY 的进程 SIGINT 缺口，回归测试先超时，再补处理器后通过。
- 保留已有 SSE 截断测试，不用文档示例覆盖原测试列表。
- 按用户请求在当前学习项目落地，未创建另一份代码副本、未提交、未推送。
- 不新增重试、Compact 或其他未在 07/08 范围内的能力。

## 结论

07 已实现且自动化通过；08 自动化和文档部分完成，真实模型手工验收尚未完成。
保留学习版边界：串行工具、词法路径限制、单写者 JSONL、无 Compact/高级 Session/完整 TUI。
