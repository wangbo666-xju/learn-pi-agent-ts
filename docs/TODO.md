# 下一步规划（TODO）

> 状态：**规划阶段，暂不写代码**。本文档记录当前实现与 pi 架构的差距分析，以及后续演进步骤。
> 每步都给出目标、涉及文件、验收标准，做一步勾一步。

---

## 0. 当前状态快照

- ✅ 流式已接入 Agent 循环：`chatStream` + `readSseChunks`，文本增量实时上屏，工具调用链路完整
- ✅ 已修：`chat()` 的 `tools: toApiTools` 笔误；两轮文本间补换行；`agent.ts` 改用 `import type`
- ⚠️ 未提交：`src/agent.ts`、`src/real-llm.ts`、`src/types.ts` 的修改 + `docs/STREAMING.md` 重写
- ⚠️ `fake-llm.ts` 整文件被注释（暂不关注）
- 📌 当前结构 = 单层 `while(true)` 循环；`chatStream` 一个方法 = 适配器 + 编排器混在一起

---

## 1. 与 pi（earendil-works/pi）的差距记录

### 1.1 一句话定位

> 我的 Agent 实现了 pi 的**内层循环（followUp）**，但缺**外层循环（steer）**、**Session 抽象**、
> 以及**消息生命周期管理**（start 入上下文 / 每帧原地替换 / done 统一收尾）。

### 1.2 核心差距：消息更新策略

| | 我的实现 | pi 的 `streamAssistantResponse` |
|---|---|---|
| 消息入上下文时机 | 流结束后才 push 完整消息 | start 事件即 push partial，流中每帧**原地替换** |
| 流内状态 | `chatStream` 局部变量（content / toolCallFragments） | 适配器产出 `event.partial` **累计快照**，编排器无状态替换 |
| 事件模型 | 原始 SSE 帧 + `onText(增量)` 回调 | 语义事件：`start` / `text_delta` / `thinking_delta` / `toolcall_delta` / `done` / `error` |
| 中途打断/报错 | 流断 → 回复丢失，上下文"断片" | partial 留在上下文，错误也走统一收尾，可恢复 |
| thinking 推理流 | `StreamChunk` 不解析 `reasoning_content`，静默丢弃 | `thinking_*` 独立事件，可展示/可存储 |
| 工具调用过程 | 参数碎片在局部拼，中途不可见 | `toolcall_start/delta/end` 事件，实时可见 |
| UI/测试 | `onText` 写死打印终端 | `emit(AgentEventSink)` 可注入：终端 / UI / 测试各订阅各的 |
| 取消 | 无 | `signal: AbortSignal` 贯穿 |

### 1.3 效果对比结论

- **顺利跑完的主路：两者输出完全相同，无区别。**
- 区别全在：① 流进行中上下文可见性；② 中途打断/报错的可恢复性；③ thinking/工具过程的可见性；④ 多端输出与可测试性。

---

## 2. 下一步计划

### P0 收尾（约 10 分钟）

- [ ] 提交当前未提交改动（agent.ts / real-llm.ts / types.ts / docs/STREAMING.md）
  - 提交信息建议：`fix(agent): 流式修复 chat 工具参数、轮间换行与 import type`

### P1 消息生命周期（最值得先做，地基）

> 目标：把"流结束后才 push"改成"start 入上下文 + 每帧原地替换 + done/error 统一收尾"。
> 对应 pi 的 `streamAssistantResponse` 编排器。

- [ ] **引入共享 context / Session**：`messages` 从 `prompt()` 局部变量提升为共享对象
  - 涉及：`src/agent.ts`、新增 `src/session.ts`（或直接放 types）
  - 验收：`prompt()` 变成 `run(session)`，消息可累积、可序列化
- [ ] **`chatStream` 拆成"适配器 + 编排器"**
  - 适配器：现有 `readSseChunks` + 累加逻辑 → 产出语义事件 `{type, partial}` 快照
  - 编排器：`streamAssistantResponse(context, emit)`：start push / 每帧替换 / done 收尾（含 `addedPartial` 判断）
  - 涉及：`src/real-llm.ts`、`src/types.ts`
  - 验收：流进行中，`context.messages` 里已有这条消息且在实时更新；打断后 partial 留在上下文

### P2 事件化输出（emit）

- [ ] `onText` 升级为 `emit({type: "message_start"|"message_update"|"message_end", message})`
  - 打印变成"订阅 message_update 的一个行为"
  - 验收：测试可注入事件收集器断言 start → update → end 序列

### P3 thinking 推理流

- [ ] `StreamChunk` 增加 `delta.reasoning_content`（DeepSeek 推理模型会发）
- [ ] 适配器产出 `thinking_start/delta/end` 事件
- [ ] 展示策略（可选）：终端折叠显示"思考中…"，或存进消息

### P4 取消 / 超时

- [ ] `AbortSignal` 贯穿 fetch 与循环
- [ ] 验收：Ctrl+C / 超时能干净中断，且 partial 消息已留在上下文（依赖 P1）

### P5 steer 双层循环（对齐 pi 完整架构）

- [ ] 先研究清楚 pi 的 `steer` / `followUp` / `nextTurn` 具体机制（外部转向从哪来）
- [ ] 抽出 `followUp()`：内层循环原语（执行一个转向直到完成）
- [ ] 加外层 `steer()` + `pendingSteers` 队列
- [ ] 验收：模型能自主规划多步任务并逐步推进

### P6 后续（按兴趣排序）

- [ ] Session 持久化（dump/load，中断续跑）
- [ ] 多工具并发/串行调度（`toolRunContexts` 状态化）
- [ ] 上下文压缩（对应 pi 的 `transformContext` 钩子）
- [ ] `convertToLlm` / `getApiKey` 配置注入，与具体厂商解耦

---

## 3. 建议的执行顺序

```text
P0（提交） → P1（消息生命周期，地基） → P2（事件化，搭在 P1 上）
          → P3/P4（thinking / 取消，可并行） → P5（steer 双层循环） → P6
```

**原则**：P1 是分水岭——做完 P1，后续所有能力（可见性、可恢复、可测试、thinking、取消）才有挂靠点；P5 是学习价值最高的部分，但依赖前面的地基。

---

## 4. 参考资料

- pi 源码：https://github.com/earendil-works/pi
- [DeepWiki: Agent Loop and AgentHarness](https://deepwiki.com/earendil-works/pi/2.1-agent-loop-and-execution-engine)
- [DeepWiki: pi-agent-core Agent Framework](https://deepwiki.com/badlogic/pi-mono/3-pi-agent-core:-agent-framework)
- [CSDN: steer / followUp / nextTurn 中途打断机制](https://yuqingteck.blog.csdn.net/article/details/161452933)
