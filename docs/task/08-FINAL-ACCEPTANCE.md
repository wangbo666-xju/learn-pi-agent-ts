# Task 8：最终验收与文档收尾执行文档

## 改动总结、效果与原因

| 改动 | 完成后的效果 | 为什么需要 |
|---|---|---|
| 端到端回归测试 | 用同一次 Run 串起工具、队列、事件和持久化 | 单个模块能运行，不代表装配后顺序正确 |
| 退出分支测试 | completed/error/aborted/max_turns/terminated 都能收尾 | 最容易留下运行锁和 pending 的是异常分支 |
| CLI 手工验收表 | 验证终端输入、真实网络和文件操作 | Fake LLM 不证明网络与终端一定正常 |
| README、演进记录、索引更新 | 文档能准确说明当前能力与限制 | 不把历史计划当作当前实现，也不把学习版写成生产平台 |

完成效果：可以把这个项目称为“包含核心执行、工具、会话、Skill 和 CLI 的学习版 Agent”，而不是“完整复刻 Pi”。

**前置条件：** Tasks 1、2A、2B、3～7 已实施。
**本任务不新增运行时功能。** 发现缺陷时先保留失败测试，再回到对应模块修复。
**技术：** node:test、FakeLlmClient、真实内存/JSONL 存储测试；真实 API 仅手工验证。
**设计依据：** [学习版设计](../PI_AGENT_LEARNING_DESIGN.md)、[任务索引](./00-INDEX.md)。

> 本文是手工实施文档。若交由 Agent 自动实施，应使用 executing-plans 按步骤执行。不能因为文档写完就把功能状态勾成已完成。

## 1. 文件清单与实施顺序

| 文件 | 操作 |
|---|---|
| test/agent-acceptance.test.ts | 新建完整文件 |
| package.json | 完整测试列表对账 |
| Readme.md | 替换现有占位内容，给出当前使用说明 |
| docs/AGENT_EVOLUTION.md | 保留历史，追加新的阶段总结 |
| docs/TODO.md | 顶部增加纠偏与当前可选方向，历史保留 |
| docs/task/00-INDEX.md | 根据实际验收结果更新状态 |
| docs/ACCEPTANCE.md | 新建验收记录，初始不冒充已通过 |

- [ ] 先加入第 2 节测试。
- [ ] 运行第 3 节自动化，修复失败后重跑。
- [ ] 执行第 4 节手工验收。
- [ ] 更新第 5～8 节文档，并记录证据。
- [ ] 最后检查 Git 差异，不自动提交。

## 2. 新建 test/agent-acceptance.test.ts：完整文件

~~~ts
import assert from "node:assert/strict";
import test from "node:test";
import Agent from "../src/agent.ts";
import {FakeLlmClient} from "../src/fake-llm.ts";
import type {AgentEvent, AgentStopReason} from "../src/agent-events.ts";
import type {AssistantMessage, Tool} from "../src/types.ts";
import {MemorySessionStore} from "../src/session/memory-session-store.ts";
import {createSessionAgent} from "../src/session/create-session-agent.ts";
import {formatSkillInvocation} from "../src/skills/skill-invocation.ts";
import {formatSkillsForSystemPrompt} from "../src/skills/system-prompt.ts";
import type {Skill} from "../src/skills/types.ts";

function createEchoTool(): Tool {
    return {
        name: "echo", description: "验收工具",
        parameters: {type: "object", properties: {}, additionalProperties: false},
        async execute(_args, signal, onUpdate) {
            signal?.throwIfAborted();
            await onUpdate?.({content: "50%"});
            signal?.throwIfAborted();
            return {content: "工具完成", terminate: false};
        },
    };
}

const toolReply: AssistantMessage = {
    role: "assistant", content: "",
    toolCalls: [{id: "c1", name: "echo", arguments: {}}],
};

test("完整链路：工具进度、steer、followUp、事件和持久化一致", async () => {
    const store = new MemorySessionStore({id: "acceptance", createdAt: 0});
    const llm = new FakeLlmClient([
        toolReply,
        {role: "assistant", content: "按新方向完成"},
        {role: "assistant", content: "后续总结完成"},
    ]);
    const agent = await createSessionAgent(store, {llm, tools: [createEchoTool()]});
    const events: AgentEvent[] = [];
    agent.subscribe((event) => {
        events.push(structuredClone(event));
        if (event.type === "turn_end" && event.turn === 1) {
            agent.followUp({role: "user", content: "最后总结"});
            agent.steer({role: "user", content: "改为只读"});
        }
    });

    const result = await agent.prompt("开始");
    assert.equal(result.reason, "completed");
    assert.equal(result.finalMessage?.content, "后续总结完成");
    assert.deepEqual(agent.state.messages.map((message) => message.role), [
        "user", "assistant", "toolResult", "user", "assistant", "user", "assistant",
    ]);
    assert.equal(llm.requests[1]?.messages.at(-1)?.content, "改为只读");
    assert.equal(llm.requests[2]?.messages.at(-1)?.content, "最后总结");

    const completed = events.flatMap((event) =>
        event.type === "message_end" ? [event.message] : [],
    );
    assert.deepEqual(await store.getMessages(), completed);
    assert.deepEqual(completed, agent.state.messages);
    assert.deepEqual(result.newMessages, completed);
    assert.equal(completed.length, 7);
    assert.equal(JSON.stringify(completed).includes('"terminate"'), false);
    assert.equal(JSON.stringify(completed).includes("50%"), false);

    assert.deepEqual(events.filter((event) =>
        event.type === "tool_execution_start" ||
        event.type === "tool_execution_update" ||
        event.type === "tool_execution_end",
    ).map((event) => event.type), [
        "tool_execution_start", "tool_execution_update", "tool_execution_end",
    ]);
    assert.deepEqual(events.filter((event) =>
        event.type === "agent_start" || event.type === "turn_start" ||
        event.type === "turn_end" || event.type === "agent_end",
    ).map((event) => event.type), [
        "agent_start", "turn_start", "turn_end",
        "turn_start", "turn_end", "turn_start", "turn_end", "agent_end",
    ]);
    assert.equal(agent.state.isRunning, false);
    assert.equal(agent.state.streamingMessage, undefined);
    assert.equal(agent.state.pendingToolCalls.size, 0);
});

for (const reason of [
    "completed", "aborted", "max_turns", "terminated", "error",
] satisfies AgentStopReason[]) {
    test("Run 出口 " + reason + " 只发布一次 agent_end", async () => {
        const llm = new FakeLlmClient([
            reason === "max_turns" || reason === "terminated"
                ? toolReply : {role: "assistant", content: "回答"},
        ]);
        const agent = new Agent({
            llm, tools: [createEchoTool()], maxTurns: 1,
            beforeToolCall: reason === "terminated"
                ? async () => ({block: true, terminate: true})
                : undefined,
            transformContext: async (messages) => {
                if (reason === "error") throw new Error("验收失败");
                return messages;
            },
        });
        const ends: AgentStopReason[] = [];
        agent.subscribe((event) => {
            if (event.type === "message_update" && reason === "aborted") agent.abort();
            if (event.type === "agent_end") ends.push(event.reason);
        });

        if (reason === "error") {
            await assert.rejects(agent.prompt("开始"), /验收失败/);
        } else {
            assert.equal((await agent.prompt("开始")).reason, reason);
        }
        await agent.waitForIdle();
        assert.deepEqual(ends, [reason]);
        assert.equal(agent.state.isRunning, false);
        assert.equal(agent.state.streamingMessage, undefined);
        assert.equal(agent.state.pendingToolCalls.size, 0);
    });
}

test("工具中取消：完整 toolCall 配对错误结果，不继续请求模型", async () => {
    const store = new MemorySessionStore({id: "abort-tool", createdAt: 0});
    const llm = new FakeLlmClient([toolReply]);
    const agent = await createSessionAgent(store, {llm, tools: [createEchoTool()]});
    agent.subscribe((event) => {
        if (event.type === "tool_execution_update") agent.abort();
    });
    const result = await agent.prompt("开始");
    assert.equal(result.reason, "aborted");
    assert.equal(llm.requests.length, 1);
    const messages = await store.getMessages();
    assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "toolResult"]);
    const last = messages.at(-1);
    assert.equal(last?.role, "toolResult");
    if (last?.role !== "toolResult") throw new Error("缺少工具结果");
    assert.equal(last.toolCallId, "c1");
    assert.equal(last.isError, true);
    assert.equal(agent.state.pendingToolCalls.size, 0);
});

test("Skill 索引不含正文，显式调用的完整指令进入请求与 Session", async () => {
    const skill: Skill = {
        name: "acceptance-skill",
        description: "测试开发规则",
        content: "唯一验收规则：先说明再执行",
        filePath: "skills/acceptance-skill/SKILL.md",
        disableModelInvocation: false,
    };
    const index = formatSkillsForSystemPrompt([skill]);
    assert.match(index, /acceptance-skill/);
    assert.equal(index.includes(skill.content), false);
    assert.equal(formatSkillsForSystemPrompt([
        {...skill, disableModelInvocation: true},
    ]), "");

    const store = new MemorySessionStore({id: "skill", createdAt: 0});
    const llm = new FakeLlmClient([{role: "assistant", content: "已理解"}]);
    const agent = await createSessionAgent(store, {llm, tools: [], systemPrompt: index});
    const input = formatSkillInvocation(skill, "只检查，不修改");
    await agent.prompt(input);
    assert.equal(llm.requests[0]?.messages[0]?.content, input);
    assert.equal((await store.getMessages())[0]?.content, input);
    assert.match(input, /唯一验收规则/);
    assert.match(input, /只检查，不修改/);
});
~~~

这个测试验证显式 Skill 的上下文装配，不宣称模型必然自动选中 Skill。自动选择由模型行为决定，需要单独手工观察 read SKILL.md。

## 3. 自动化验收：完整命令和通过标准

### 3.1 package.json：只替换 scripts.test

保留 scripts.dev、scripts.check 和全部依赖，test 的完整值为：

~~~json
"test": "tsx --test test/agent.test.ts test/agent-loop.test.ts test/agent-control.test.ts test/message-queue.test.ts test/context.test.ts test/memory-session-store.test.ts test/jsonl-session-store.test.ts test/session-manager.test.ts test/skills.test.ts test/real-llm.test.ts test/cli-agent-runner.test.ts test/agent-state.test.ts test/agent-events.test.ts test/execute-tools.test.ts test/session-event-listener.test.ts test/cli-command.test.ts test/cli-event-renderer.test.ts test/cli-runtime.test.ts test/agent-acceptance.test.ts"
~~~

如果自己新增了其他测试，将其保留在末尾，不用这段覆盖掉自己的测试。

### 3.2 执行命令

工作目录为 agent-ts 项目根目录，不是 Pi 根目录。

~~~powershell
npx tsx --test test/agent-acceptance.test.ts
npm run check
npm test
node --input-type=module -e "await import('./src/agent.ts'); await import('./src/agent-loop.ts'); await import('./src/execute-tools.ts'); await import('./src/session/create-session-agent.ts'); await import('./src/cli-agent-runner.ts')"
git diff --check
~~~

| 检查 | 通过标准 |
|---|---|
| 新增验收测试 | 全部通过，不使用真实 API |
| 类型检查 | 退出码 0，无 TS 错误 |
| 全部单元测试 | 0 failed、0 cancelled；不能靠 skip 掩盖缺陷 |
| Node 直接导入 | 无运行时类型导入错误、无不可擦除 TS 语法错误 |
| diff 检查 | 无新增尾随空白等错误 |

这里不导入 main.ts，避免启动交互式 CLI 或创建 Session。使用 Node v24.13.0 或已验证兼容的版本；不新增 constructor 参数属性、enum 等需要编译转换的语法。

### 3.3 容易漏掉的测试归属

| 能力 | 应查看的测试 |
|---|---|
| partial 取消、运行锁、continue、shouldStop | test/agent-control.test.ts |
| 参数校验、before/after、进度失败、取消补结果 | test/execute-tools.test.ts |
| 保存失败、JSONL 恢复、不重复写入 | test/session-event-listener.test.ts |
| CLI 运行中控制、拒绝切会话 | test/cli-runtime.test.ts |
| SSE 解析与模型适配 | test/real-llm.test.ts |
| Skill 目录与格式解析 | test/skills.test.ts |
| 本次组合链路与五种结束原因 | test/agent-acceptance.test.ts |

Fake LLM 的取消测试验证调用链与 State，不等于测试了真实 HTTP 连接断开。网络取消仍需要第 4 节手工验收。

## 4. 真实模型与 CLI 手工验收

这一步由你手工执行，会使用 API 配额。自动测试通过不应自动触发真实模型调用。

在 IDEA 实际运行的 Node 配置中设置 OPENAI_API_KEY、OPENAI_BASE_URL、OPENAI_MODEL；用 npm run dev 启动时，当前终端也必须有这三个变量。IDEA 的配置不会自动传给另一个终端。

~~~powershell
npm run dev
~~~

按表逐项记录；模型执行太快时，运行控制可先以自动化测试为准，再选择较长的只读任务观察。

| 操作 | 检查结果 |
|---|---|
| 输入“用中文说明你能做什么” | 文本分段出现，结束 /status 为 false |
| 要求 read Readme.md | 工具事件后，模型基于 toolResult 回答 |
| 要求创建 task8-acceptance-only.txt，内容 acceptance | 仅该文件被创建，工具结果成功 |
| 要求读取 ../outside.txt | 路径工具明确拒绝，不读取工作区外文件 |
| 运行中 /steer 后续只读，不修改 | 当前 Turn 后新 user 被加入 |
| 运行中 /followup 最后用一句话总结 | 原任务结束后再处理 |
| 运行中 /new、/resume 任一 ID | 拒绝切换，当前 Session 不变 |
| 运行中 /abort | 网络/工具配合取消，运行收尾后仍能输入 |
| 空闲后 /new，再问“之前干了什么” | 新会话不携带旧历史 |
| /resume 原 ID，再询问历史 | 原历史进入新的请求 |
| /skills | 能找到本地 Skill |
| /skill:agent-ts-development 只分析，不修改 | 完整 Skill 指令进入本轮 user 与 JSONL |
| 普通任务匹配某个 Skill 描述 | 观察是否 read SKILL.md；没有读取就不能记自动选择通过 |
| /exit；重新启动后 Ctrl+C | 能退出，不留下本次未结束的请求 |

验收文件若已存在，换一个未使用名称，不覆盖已有数据。验收结束只删除本次明确创建的测试文件，不删除 sessions 历史。

.env 策略：Task 5 增加的是 block+terminate 能力，不是默认自动给所有拒绝加 terminate。是否立即停止应以 tool-policy.ts 的实际返回值为准，不能只看模型最后说了什么。

## 5. Readme.md：完整内容

当前文件是占位内容。实施本任务时替换为下面内容；如果你已经补充了其他有效说明，合并保留，不删除。

~~~~markdown
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

## 当前限制

工具固定串行，Schema 只支持当前 object/string 子集。
路径限制是词法边界，不是抵御符号链接/junction 的完整沙箱。
JSONL 假定单写者，没有事务、崩溃修复和跨进程并发保证。
不提供 Compact、Session fork/lane/record、图片、thinking/usage、TUI、多 Provider 调度或遥测。

[开发任务](docs/task/00-INDEX.md) · [演进记录](docs/AGENT_EVOLUTION.md) · [验收记录](docs/ACCEPTANCE.md)
~~~~

## 6. docs/AGENT_EVOLUTION.md：保留历史，追加下面内容

~~~~markdown
## 核心运行时阶段：State、Event、Context 与双层 Loop

以前靠一个循环完成请求与工具调用，现在分出 Agent 管控制、Loop 管编排、LLM 管协议适配。

增加统一 AgentState 和 AgentEvent；partial 只更新实时 State，完整消息进入历史。
Context 的 transform/convert 只准备本次请求，不直接删改持久化历史。

运行控制包含 abort、waitForIdle、continue、reset、steer、followUp。
内层循环处理工具续跑与 steer；外层处理 followUp。
maxTurns 统计整个 Run 的模型请求次数，所有结束路径统一清理临时状态。

## 工具与持久化阶段：统一执行与事件订阅

工具统一经过查找、参数校验、before、execute、after 和结果生成。
新增 signal、进度事件和 terminate；普通工具错误能回传，取消不回滚已发生的副作用。

Agent 不再依赖 SessionStore。createSessionAgent 恢复历史并注册保存监听器，
仅 message_end 追加 JSONL，避免流式片段与旧历史重复保存。

## CLI 阶段：边运行边控制

输入循环不再等待整个 Prompt。CLI Runner 管后台任务、错误与会话切换保护，
Renderer 订阅事件显示文本和工具状态。

旧记录中的“尚未实现 Session/Skill/运行控制”等描述仅代表当时阶段；
当前完成情况以 docs/task/00-INDEX.md 和 docs/ACCEPTANCE.md 为准。

## 本阶段保留的边界

不实现生产级沙箱、JSONL 事务恢复、工具并发、Compact、高级 Session 和 TUI。
完成核心链路后再按学习需要选下一项，不以复刻全部 Pi 功能作为完成标准。
~~~~

只有功能已实施后才追加此“完成阶段”总结；如果自动化或手工验收未结束，在顶部标明“实现完成，验收进行中”。

## 7. docs/TODO.md 与任务索引：更新什么

### 7.1 在 docs/TODO.md 顶部插入，旧计划留作历史

~~~~markdown
# 当前后续方向

旧文档只用于保留学习过程，不作为当前施工清单。
其中曾把内外层名称写反：当前实现是内层处理工具续跑/steer，外层处理 followUp。
当前 partial 保存在 streamingMessage，只有完整消息进入历史；不沿用旧文档的 partial 落库设想。

核心任务状态见 [任务索引](task/00-INDEX.md)，测试证据见 [验收记录](ACCEPTANCE.md)。

## 可选扩展，不影响学习版核心完成

- Context Compact：摘要与最近消息，以及恢复时的压缩记录。
- 高级 Session：fork、lane、record，与普通消息的区分。
- 工具并发：按工具能力决定串行或并行，处理同路径冲突。
- 图片输入与 thinking/usage：扩展消息和事件协议。
- 多 Provider 与重试：适配差异、限流、超时、成本统计。
- 安全与恢复：真实路径检查、符号链接策略、JSONL 损坏检测。
- TUI 或 HTTP 服务：复用 Agent，替换交互入口。

---

以下为早期历史计划：
~~~~

### 7.2 docs/task/00-INDEX.md

不是现在把所有行写成完成。执行完验收后：

1. 对已经通过自动化的 01、02A、02B、03～07 行，把状态改成“已实现，自动化通过”。
2. 08 只有自动化与手工表都完成，才改成“已验收”。
3. 删除末尾过时的“当前 Task 1 已完成，下一步从 Task 2A 开始”，替换成：

~~~~markdown
当前任务状态以上表为准，验收结果见 [ACCEPTANCE.md](../ACCEPTANCE.md)。
下一项从尚未完成的任务开始；不要按历史叙述推断实现进度。
~~~~

如果未提交，不编造 commit。提交后通过 git log -1 --oneline 获取真实标识，写入验收记录。

## 8. 新建 docs/ACCEPTANCE.md：初始记录模板

下面是用于记录的表，不是“已通过”的声明。执行一项后填入实际结果；未执行保留未执行。

~~~~markdown
# 学习版 Agent 验收记录

## 环境

| 项目 | 记录 |
|---|---|
| 验收日期 | 未记录 |
| Node 版本（node --version） | 未记录 |
| Git 提交（git log -1 --oneline） | 未记录 |
| 工作区是否有未提交代码 | 未记录 |
| 模型名称、BASE_URL | 未记录；不记录 API Key |

## 自动化

| 项目 | 状态 | 证据 |
|---|---|---|
| agent-acceptance 测试 | 未执行 | 无 |
| npm run check | 未执行 | 无 |
| npm test | 未执行 | 无 |
| Node strip-only 导入 | 未执行 | 无 |
| git diff --check | 未执行 | 无 |

## 手工

| 场景 | 状态 | 观察结果 |
|---|---|---|
| 流式回答、read/write、越界拒绝 | 未执行 | 无 |
| status/steer/followup/abort | 未执行 | 无 |
| 运行中拒绝切会话 | 未执行 | 无 |
| new/resume 历史隔离与恢复 | 未执行 | 无 |
| Skill 显式调用与自动读取 | 未执行 | 无 |
| exit/Ctrl+C 清理 | 未执行 | 无 |

## 结论

尚未验收完成。完成上述检查后，记录实际通过项与保留限制，再更新任务索引。
~~~~

## 9. 收尾检查、断点与通俗说明

~~~powershell
git diff --check
git status --short
git diff --stat
~~~

只检查自己实施的改动，不清理已有用户文件，不自动提交。验证完成后可使用：

~~~text
docs(agent): 补齐学习版端到端验收与架构使用说明
~~~

断点建议：验收测试 agent.prompt → Loop.runTurn → executeTools → SessionListener → shouldStop/队列分支 → agent_end → Agent.finally。

本任务解决的是“能否证明完成”。Fake LLM 负责确定性的行为证明，真实 CLI 负责网络与交互验证，文档负责说明边界。

完成标准不是“文件都存在”，而是：输入能执行、工具能回传、任务能控制、消息能恢复、Skill 能进入上下文，且失败后不会卡在运行状态。学习版达到这个闭环即可，不需要同时实现 Pi 的所有高级功能。
