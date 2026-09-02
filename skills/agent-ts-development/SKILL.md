---
name: agent-ts-development
description: 修改、调试或扩展当前 TypeScript Agent 项目时使用，适用于 Agent Loop、Tool Calling、Session、CLI、Skill 与流式输出相关任务。
---

# Agent TS 开发规范

## 当前架构

- `agent.ts` 负责 Agent Loop：调用模型、执行工具、把结果回填给模型。
- `tools/` 负责单一外部动作：读取、写入与列目录。
- `session/` 负责消息持久化、恢复与 Session 切换。
- `main.ts` 与 `cli-command.ts` 负责 CLI 命令解析和路由。
- `skills/` 存放可复用的专业工作流；本文件是当前项目的开发 Skill。

## 修改原则

1. 修改前先读取相关文件，并确认调用链。
2. 功能归属保持清晰：CLI 不承担 Agent 逻辑；Agent 不直接处理文件系统细节；Tool 不管理 Session。
3. 新增行为时优先补充测试，再写最小实现。
4. 涉及工具调用时，确认结果按 `assistant -> toolResult -> assistant` 回填并持久化。
5. 涉及 Session 时，确认不同 JSONL 文件的历史不会混合。

## TypeScript 与运行约束

项目当前可由 Node 直接运行 `.ts` 文件。避免使用 Node strip-only mode 不支持的 TypeScript 参数属性：

```ts
// 不使用
constructor(private readonly root: string) {}

// 使用
private readonly root: string;

constructor(root: string) {
    this.root = root;
}
```

纯类型必须使用 `import type`，不能在运行时导入：

```ts
import type { AgentMessage, Tool } from "./types.ts";
```

## 验证

修改后执行：

```powershell
npx tsc --noEmit
```

修改 Session、Skill 或 CLI 时，还应运行对应的单测，并手工验证：

```text
/new
/sessions
/resume <sessionId>
/skills
/skill:agent-ts-development <任务>
```
