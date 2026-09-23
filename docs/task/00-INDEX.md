# Pi Agent 学习版任务索引

## 目标

在现有 Loop、SSE、Tool、Session 和 Skill 基础上，补齐 Pi 风格 Agent Core 的状态、事件、上下文、运行控制和工具生命周期。

设计总览：[`../PI_AGENT_LEARNING_DESIGN.md`](../PI_AGENT_LEARNING_DESIGN.md)

## 执行顺序

| 顺序 | 文档 | 结果 | 状态 |
|---|---|---|---|
| 1 | [`01-AGENT-STATE-AND-EVENT.md`](./01-AGENT-STATE-AND-EVENT.md) | 建立状态和生命周期事件协议 | 已实现，自动化通过 |
| 2A | [`02A-LLM-STREAM-EVENTS.md`](./02A-LLM-STREAM-EVENTS.md) | SSE 转换为模型语义事件 | 已实现，自动化通过 |
| 2B | [`02B-CONTEXT-PIPELINE.md`](./02B-CONTEXT-PIPELINE.md) | 建立 transform → convert 管线 | 已实现，自动化通过 |
| 3 | [`03-EVENT-DRIVEN-AGENT-LOOP.md`](./03-EVENT-DRIVEN-AGENT-LOOP.md) | Agent Loop 发出事件并更新 State | 已实现，自动化通过 |
| 4 | [`04-RUN-CONTROL-AND-DOUBLE-LOOP.md`](./04-RUN-CONTROL-AND-DOUBLE-LOOP.md) | abort、continue、steer、followUp | 已实现，自动化通过 |
| 5 | [`05-TOOL-LIFECYCLE.md`](./05-TOOL-LIFECYCLE.md) | 校验、Hook、进度、terminate | 已实现，自动化通过 |
| 6 | [`06-SESSION-EVENT-PERSISTENCE.md`](./06-SESSION-EVENT-PERSISTENCE.md) | message_end 驱动 Session 落盘 | 已实现，自动化通过 |
| 7 | [`07-CLI-RUNTIME-CONTROL.md`](./07-CLI-RUNTIME-CONTROL.md) | CLI 展示事件和控制运行 | 已实现，自动化通过 |
| 8 | [`08-FINAL-ACCEPTANCE.md`](./08-FINAL-ACCEPTANCE.md) | 文档与端到端验收 | 自动化通过，真实模型手工验收待执行 |

## 后续学习：手动 Compact（两步）

用户已反馈完成此前手工体验；原 08 验收表保留实际记录，未替用户补造逐项证据。

| 顺序 | 文档 | 结果 | 状态 |
|---|---|---|---|
| 9 | [09-MANUAL-COMPACT.md](09-MANUAL-COMPACT.md) | 从流程和原因入手，分块实现 /compact | 设计文档，待实施 |
| 10 | [10-COMPACT-VERIFICATION.md](10-COMPACT-VERIFICATION.md) | 恢复、重复压缩、取消与保存失败验证 | 设计文档，待实施 |

先读 09 的总体链路，再按 10 的测试逐块实现；本阶段不包含自动 Token 阈值。

## 固定约束

- 按依赖顺序执行任务，验证通过后进入下一项；提交由用户决定。
- 先写测试并确认按预期失败，再写实现。
- 使用 Node strip-only 可执行语法；纯类型使用 `import type`。
- 不引入 `any`，不修改或删除已有 Session 数据。
- 第一版工具保持顺序执行，不实现并行模式。
- 每个任务结束执行局部测试、`npm test` 和 `npm run check`。

## 模块依赖

```text
Task 1 State/Event
  ├─ Task 2A LLM Stream Event
  └─ Task 2B Context Pipeline
           ↓
Task 3 Event-driven Agent Loop
           ↓
Task 4 Run Control + Double Loop
           ↓
Task 5 Tool Lifecycle
           ↓
Task 6 Session Event Persistence
           ↓
Task 7 CLI Runtime Control
           ↓
Task 8 Final Acceptance
```

## 完成定义

```text
prompt → 流式事件 → tool calling → toolResult → 最终回答
运行时可 abort / waitForIdle / continue
运行中可 steer，结束后可 followUp
完整消息自动进入 JSONL Session
Skill 自动索引和显式调用保持可用
```

## 通俗说明

这份索引相当于项目的施工导航，不需要一次看完所有文档。Task 1 是地基；Task 2A 和 2B 分别整理模型输出与模型输入；Task 3 再把它们接入 Loop；Task 4-7 逐步补上运行控制、工具、Session 和 CLI。

当前任务状态以上表为准，2026-09-21 全套 73 项测试通过，验收结果见 [ACCEPTANCE.md](../ACCEPTANCE.md)。
下一步完成 08 的真实模型手工验收；不要按历史叙述推断实现进度。
