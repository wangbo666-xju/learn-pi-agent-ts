# Task 8：最终验收与文档收尾 Implementation Plan

**Goal:** 用自动化测试和真实 CLI 场景证明学习版 Agent 的核心能力完整，并让 README、演进记录和代码保持一致。

**Architecture:** 本任务不增加新的 Agent 能力，只修复验收发现的问题并更新说明。任何行为问题必须先增加失败测试，再修改实现。

**Depends on:** Tasks 1-7 全部完成。

## 修改范围

```text
修改 Readme.md
修改 docs/AGENT_EVOLUTION.md
修改 docs/TODO.md
修改 docs/task/00-INDEX.md
按验收结果修改对应测试和源码
```

## Step 1：自动化验收

执行完整测试：

```powershell
npm test
```

要求：

```text
0 failed
0 cancelled
0 skipped
```

执行类型检查：

```powershell
npm run check
```

要求：退出码为 0，没有 TypeScript 错误。

执行 Node strip-only 导入检查：

```powershell
node --input-type=module -e "import('./src/agent.ts'); import('./src/agent-loop.ts'); import('./src/agent-state.ts'); import('./src/agent-events.ts')"
```

要求：没有 `.js` 路径错误、运行时类型导入错误或不支持的 TypeScript 语法。

## Step 2：Fake LLM 端到端验收

增加一个端到端测试，使用真实 Agent、MemorySessionStore、FakeLlmClient 和 TestTool，验证：

```text
user
→ assistant(toolCall)
→ toolResult
→ steer user
→ assistant(final)
→ followUp user
→ assistant(final)
```

同时断言：

```text
AgentEvent 顺序完整
Session 只保存 message_end
工具结果没有持久化 terminate
agent.state.isRunning 最终为 false
pendingToolCalls 最终为空
```

最终回归集必须另外覆盖这些容易遗漏的异常与分支路径：

```text
Session 的 message_end 保存失败 → Run reject，但运行状态完成清理
SSE 中途 abort → streamingMessage 清空
工具执行中途 abort → pendingToolCalls 清空
continue：空 initialMessages、最后一条 toolResult、assistant+steer、assistant+followUp
shouldStopAfterTurn / steer / toolResult / followUp → 固定优先级
beforeToolCall 返回 block+terminate → Loop 正确终止
CLI 运行中允许 /abort，拒绝 /new 和 /resume
success / error / abort / max_turns → 每条路径都只发布一次 agent_end
```

如果测试暴露问题，保留失败测试并只修改对应模块。

## Step 3：真实模型 CLI 验收

配置：

```text
OPENAI_API_KEY
OPENAI_BASE_URL
OPENAI_MODEL
```

启动：

```powershell
npm run dev
```

依次验证：

```text
1. 普通问题：文本逐段输出，结束后 isRunning=false
2. 读取文件：read 完成后模型根据 toolResult 回答
3. 写文件：beforeToolCall 生效，写入工作区内文件
4. 访问 ../：resolvePath 拒绝工作区外路径
5. /steer：当前 Turn 完成后优先注入
6. /followup：当前任务结束后继续
7. /abort：fetch 中断并回到可输入状态
8. /new：创建独立 JSONL
9. /resume：恢复后模型能看到历史
10. /skill:agent-ts-development：完整 Skill 进入本轮上下文
```

测试文件使用明确的临时名称，验收后只删除这次创建的文件，不操作 Session 历史。

## Step 4：更新 README

README 固定包含：

```text
项目定位与非目标
Node/TypeScript 版本
环境变量配置
npm run dev / npm test / npm run check
总体架构图
AgentEvent 顺序
Tool Calling 流程
Session JSONL 结构
Skill 自动与显式调用
CLI 命令列表
源码目录说明
```

## Step 5：更新学习记录

- `docs/AGENT_EVOLUTION.md`：保留历史阶段，追加 State/Event、双层 Loop、控制、事件持久化阶段。
- `docs/TODO.md`：只保留可选扩展，不再把已完成能力列为未完成。
- `docs/task/00-INDEX.md`：将 Tasks 1-8 全部改为已完成，并记录对应 commit。

可选扩展固定列为：

```text
Context Compact
Session fork/lane/record
parallel/sequential 工具模式
图片输入
thinking/usage
TUI
多 Provider
遥测
```

## Step 6：最终工作区检查

```powershell
git diff --check
git status --short
```

只暂存本任务实际修改的路径，不使用 `git add .` 或 `git add -A`。

建议提交：

```text
docs(agent): finish pi-style learning agent guide
```

## 完成标准

达到以下结果后项目进入“学习版 Agent 完成”状态：

```text
统一 State
+ 生命周期 Event
+ SSE 语义流
+ Context 管线
+ Tool Calling 完整管线
+ abort/continue/waitForIdle
+ steer/followUp
+ JSONL Session
+ Skill
+ 可控制 CLI
```
