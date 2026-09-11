# Task 6：Session 事件持久化执行文档

## 改动总结、效果与原因

本任务不是重写 JSONL，而是把“谁负责保存消息”从 Agent 内部移到 Session 订阅器。

| 改动 | 完成后的效果 | 为什么需要 |
|---|---|---|
| Agent 不再依赖 SessionStore | 不接存储也能直接运行 Agent | 核心循环不应绑定文件或数据库 |
| message_end 订阅器 | 完整消息统一追加一次 | 避免流式片段重复保存、多个位置重复 append |
| createSessionAgent 异步工厂 | 先恢复历史，再创建 Agent，再接存储 | constructor 不能 await，初始化顺序必须明确 |
| 存储失败向上传播 | Prompt 报错，但运行状态能清理 | 不能显示成功却悄悄丢失会话记录 |

例子：流式输出“你”“你好”只更新 State；最终 message_end("你好") 才存一条 assistant。重新打开 JSONL 时恢复这条完整消息，不重放保存事件。

**前置条件：** Task 5 完成，AgentOptions 已有 afterToolCall。
**输入：** SessionStore、去除存储字段的 AgentOptions。
**输出：** createSessionEventListener(store)、createSessionAgent(store, options)。
**技术：** 现有 JSONL/MemoryStore、可等待事件总线，不引入数据库。
**设计依据：** [学习版设计](../PI_AGENT_LEARNING_DESIGN.md)、[Task 5](./05-TOOL-LIFECYCLE.md)。

> 本文是手工实施文档。若交由 Agent 自动实施，应使用 executing-plans 按步骤执行；不要重复实施此前已完成的修改。

## 1. 文件清单与实施顺序

| 文件 | 操作 |
|---|---|
| src/session/session-event-listener.ts | 新建完整文件 |
| src/session/create-session-agent.ts | 新建完整文件 |
| src/agent.ts | 删除存储依赖，替换 handleEvent |
| src/main.ts | 替换 createAgent 工厂，其余 CLI 暂不改 |
| test/helpers/create-test-agent.ts | 新建测试装配辅助函数 |
| test/agent.test.ts | 迁移构造调用 |
| test/agent-control.test.ts | 迁移构造调用 |
| test/execute-tools.test.ts | 迁移 Agent 集成测试构造调用 |
| test/session-event-listener.test.ts | 新建完整测试 |
| package.json | 追加测试文件 |

JsonlSessionStore、MemorySessionStore、SessionManager 和 JSONL version 不改。现有 test/jsonl-session-store.test.ts 继续保留，它测试底层存储；本任务另测“Agent + 存储”的组合。

- [ ] 先创建第 6 节测试，执行后确认缺少新模块。
- [ ] 实施第 2～5 节，迁移旧测试。
- [ ] 执行第 7 节验收。

## 2. 新建 src/session/session-event-listener.ts

~~~ts
import type {AgentEventListener} from "../agent-events.ts";
import type {SessionStore} from "./session-store.ts";

/** 只订阅完整消息，忽略 partial、工具进度和运行状态事件。 */
export function createSessionEventListener(
    store: SessionStore,
): AgentEventListener {
    return async (event) => {
        if (event.type === "message_end") {
            await store.appendMessage(event.message);
        }
    };
}
~~~

这里必须 await。当前事件总线按订阅顺序逐个等待；写入失败就抛出，Loop 不会继续请求下一轮模型。

这保证的是正常单写者运行中的有序追加，不是数据库事务，也不是崩溃恢复意义上的 exactly-once。磁盘写到一半、进程中断、多个 Agent 同写一个 JSONL，都不在本任务保证范围内。

## 3. src/agent.ts：删除五处存储耦合

### 3.1 删除 SessionStore 类型导入

删除这一整行：

~~~ts
import type {SessionStore} from "./session/session-store.ts";
~~~

### 3.2 AgentOptions 整体替换

其他导入在 Task 5 已存在；保留 AfterToolCall、AgentLoopConfig 等导入。

~~~ts
export type AgentOptions = {
    llm: LlmClient;
    tools: Tool[];
    beforeToolCall?: BeforeToolCall;
    afterToolCall?: AfterToolCall;
    systemPrompt?: string;
    initialMessages?: AgentMessage[];
    maxTurns?: number;
    transformContext?: TransformContext;
    convertToLlm?: ConvertToLlm;
    shouldStopAfterTurn?: AgentLoopConfig["shouldStopAfterTurn"];
};
~~~

### 3.3 删除类字段

~~~ts
private readonly sessionStore: SessionStore;
~~~

### 3.4 删除 constructor 中的赋值

~~~ts
this.sessionStore = options.sessionStore;
~~~

### 3.5 整体替换 handleEvent

~~~ts
private async handleEvent(event: AgentEvent): Promise<void> {
    // Loop 负责历史消息；这里先更新实时 State，再通知外部订阅者。
    this.applyEvent(event);
    await this.events.emit(event);
}
~~~

不改 startRun、applyEvent 和 agent-loop.ts：不要再次 push 消息，不要在 Loop 中新加 appendMessage。

Task 4 的 handleEvent 原本保存一次。只加订阅器而不删原保存逻辑，会导致每条消息写两次。

## 4. 新建 src/session/create-session-agent.ts

~~~ts
import Agent, {type AgentOptions} from "../agent.ts";
import {createSessionEventListener} from "./session-event-listener.ts";
import type {SessionStore} from "./session-store.ts";

/**
 * 装配层：先从 Store 恢复完整历史，再把新消息保存监听器接到 Agent。
 * 只允许 Store 提供 initialMessages，避免两个历史来源互相覆盖。
 */
export async function createSessionAgent(
    store: SessionStore,
    options: Omit<AgentOptions, "initialMessages">,
): Promise<Agent> {
    const initialMessages = await store.getMessages();
    const agent = new Agent({...options, initialMessages});
    agent.subscribe(createSessionEventListener(store));
    return agent;
}
~~~

Omit<AgentOptions, "initialMessages"> 表示“使用 AgentOptions 的全部字段，但排除 initialMessages”。
这是类型操作，不是运行时函数；这里恢复历史只有 Store 一个来源。

### 4.1 src/main.ts：替换 createAgent 方法

加入顶层导入：

~~~ts
import {createSessionAgent} from "./session/create-session-agent.ts";
~~~

把原 async function createAgent(...) 整体替换为：

~~~ts
async function createAgent(sessionStore: SessionStore): Promise<Agent> {
    const agent = await createSessionAgent(sessionStore, {
        llm: new RealLlmClient(),
        tools: [
            new ReadFileTool(cwd),
            new WriteFileTool(cwd),
            new ListDirTool(cwd),
        ],
        beforeToolCall: policy,
        systemPrompt,
    });

    // 工厂已注册持久化；此处只注册显示，不再注册第二个存储监听器。
    agent.subscribe((event) => {
        if (event.type === "message_update" && event.update.type === "text_delta") {
            stdout.write(event.update.delta);
        }
        if (event.type === "tool_execution_end") {
            const state = event.isError ? "error" : "done";
            console.log("\n工具执行状态：" + event.toolName + ":" + state);
        }
    });
    return agent;
}
~~~

原来的 cwd、policy、systemPrompt、RealLlmClient、工具类和 SessionStore 导入保留。
/new 与 /resume 仍调用 createAgent，所以自动接入新装配方式。CLI 并发输入留到 Task 7。

如果你已经给 Agent 配置 afterToolCall、maxTurns 或其他选项，把原来的同名配置保留在上面的 options 对象中，不改成默认值。

## 5. 旧测试如何迁移：不要只删 sessionStore 参数

旧测试里有“Store 最后保存了几条”的断言。删除参数却忘记订阅，会导致 Agent 能回答、Store 却为空。

新建 test/helpers/create-test-agent.ts，完整内容：

~~~ts
import Agent, {type AgentOptions} from "../../src/agent.ts";
import {createSessionEventListener} from "../../src/session/session-event-listener.ts";
import type {SessionStore} from "../../src/session/session-store.ts";

/** 仅用于旧测试的装配，不是生产 Agent 的存储接口。 */
export function createTestAgent(
    options: AgentOptions & {sessionStore: SessionStore},
): Agent {
    const {sessionStore, ...agentOptions} = options;
    const agent = new Agent(agentOptions);
    agent.subscribe(createSessionEventListener(sessionStore));
    return agent;
}
~~~

它不恢复历史，只迁移原来“构造后自动保存”的测试装配。恢复行为使用第 6 节的异步工厂测试。

对以下三个文件逐一操作：

- test/agent.test.ts
- test/agent-control.test.ts
- test/execute-tools.test.ts（只有最后一个集成测试使用 Agent）

把导入：

~~~ts
import Agent from "../src/agent.ts";
~~~

替换为：

~~~ts
import {createTestAgent} from "./helpers/create-test-agent.ts";
~~~

把文件内所有 new Agent({ 替换成 createTestAgent({，对象内的 sessionStore 和其余配置全部保留。结尾仍然是 });，不要多删括号。

转换示例：

~~~ts
const store = new MemorySessionStore({id: "test", createdAt: 0});
const agent = createTestAgent({
    llm: new FakeLlmClient([{role: "assistant", content: "回答"}]),
    tools: [],
    sessionStore: store,
});
~~~

这是精确的测试装配迁移，不要把 createTestAgent 引入 src。
Task 4 已把 prompt 返回值迁为 AgentRunResult；不要退回消息数组。

## 6. 新建 test/session-event-listener.test.ts：完整文件

~~~ts
import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {FakeLlmClient} from "../src/fake-llm.ts";
import {MemorySessionStore} from "../src/session/memory-session-store.ts";
import {JsonlSessionStore} from "../src/session/jsonl-session-store.ts";
import {createSessionEventListener} from "../src/session/session-event-listener.ts";
import {createSessionAgent} from "../src/session/create-session-agent.ts";
import type {AgentEvent} from "../src/agent-events.ts";

test("partial 和工具进度不持久化，message_end 只保存一次", async () => {
    const store = new MemorySessionStore({id: "test", createdAt: 0});
    const listener = createSessionEventListener(store);
    await listener({
        type: "message_start",
        message: {role: "assistant", content: ""},
    });
    await listener({
        type: "message_update",
        message: {role: "assistant", content: "你"},
        update: {type: "text_delta", delta: "你"},
    });
    await listener({
        type: "tool_execution_update",
        toolCallId: "c1", toolName: "echo",
        partialResult: {content: "50%"},
    });
    assert.deepEqual(await store.getMessages(), []);
    await listener({
        type: "message_end",
        message: {role: "assistant", content: "你好"},
    });
    assert.deepEqual(await store.getMessages(), [
        {role: "assistant", content: "你好"},
    ]);
});

test("JSONL 恢复历史后继续，不重复保存旧消息", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "agent-session-events-"));
    t.after(() => rm(directory, {recursive: true, force: true}));
    const file = join(directory, "session.jsonl");
    const firstStore = await JsonlSessionStore.create(file, {id: "test", createdAt: 0});
    const first = await createSessionAgent(firstStore, {
        llm: new FakeLlmClient([{role: "assistant", content: "第一次回答"}]),
        tools: [],
    });
    await first.prompt("第一次提问");

    const reopened = await JsonlSessionStore.open(file);
    const llm = new FakeLlmClient([{role: "assistant", content: "第二次回答"}]);
    const second = await createSessionAgent(reopened, {llm, tools: []});
    // 初始化不会重发 message_end，因此此时磁盘仍然只有两条消息。
    assert.equal((await reopened.getMessages()).length, 2);
    await second.prompt("第二次提问");

    assert.deepEqual(llm.requests[0]?.messages, [
        {role: "user", content: "第一次提问"},
        {role: "assistant", content: "第一次回答"},
        {role: "user", content: "第二次提问"},
    ]);
    assert.equal((await reopened.getMessages()).length, 4);
    assert.deepEqual((await reopened.getEntries()).map((entry) => entry.seq), [1, 2, 3, 4]);
    const lines = (await readFile(file, "utf8")).trim().split(/\r?\n/);
    assert.equal(lines.length, 5); // header + 四条 message
    assert.deepEqual(
        await (await JsonlSessionStore.open(file)).getMessages(),
        second.state.messages,
    );
});

test("持久化失败向上传播，但运行锁和临时状态会清理", async () => {
    const store = new MemorySessionStore({id: "broken", createdAt: 0});
    store.appendMessage = async () => { throw new Error("磁盘写入失败"); };
    const llm = new FakeLlmClient([]);
    const agent = await createSessionAgent(store, {llm, tools: []});
    const events: AgentEvent[] = [];
    agent.subscribe((event) => { events.push(event); });

    await assert.rejects(agent.prompt("开始"), /磁盘写入失败/);
    await agent.waitForIdle();
    assert.equal(agent.state.isRunning, false);
    assert.equal(agent.state.streamingMessage, undefined);
    assert.equal(agent.state.pendingToolCalls.size, 0);
    assert.equal(events.filter((event) => event.type === "agent_end").length, 1);
    assert.equal(llm.requests.length, 0);
    assert.equal((await store.getMessages()).length, 0);
    // Loop 已追加内存后才发 message_end。失败不代表内存自动回滚。
    assert.equal(agent.state.messages.length, 1);
});

test("外部 message_end 监听器执行前，存储已完成", async () => {
    const store = new MemorySessionStore({id: "ordered", createdAt: 0});
    const agent = await createSessionAgent(store, {
        llm: new FakeLlmClient([{role: "assistant", content: "ok"}]),
        tools: [],
    });
    let count = 0;
    agent.subscribe(async (event) => {
        if (event.type === "message_end") {
            count++;
            assert.equal((await store.getMessages()).length, count);
        }
    });
    await agent.prompt("开始");
    assert.equal(count, 2);
});
~~~

测试临时目录只删除本测试 mkdtemp 创建的目录，不操作项目 sessions。

## 7. 验证与定位重复保存

在 package.json 的 scripts.test 末尾追加 test/session-event-listener.test.ts。

~~~powershell
npx tsx --test test/session-event-listener.test.ts test/agent.test.ts test/agent-control.test.ts test/execute-tools.test.ts test/jsonl-session-store.test.ts
npm run check
npm test
rg -n "appendMessage|sessionStore" src/agent.ts src/agent-loop.ts
rg -n "createSessionEventListener|createSessionAgent" src
git diff --check
~~~

第一个 rg 应没有匹配，退出码 1 表示“未找到”，不是代码运行失败。
第二个 rg 应看到存储监听器及工厂调用；main 不能重复注册同一存储监听器。

验收标准：

- [ ] 普通问答只保存 user + assistant 两条。
- [ ] 工具交互只保存完整 assistant(toolCalls) 和 toolResult，不保存进度。
- [ ] 恢复历史不会把旧消息再写一遍。
- [ ] 保存失败会报错，waitForIdle 能结束。

建议提交：

~~~text
refactor(agent): 通过事件订阅持久化完整会话消息
~~~

## 8. 通俗说明与断点

~~~text
创建/恢复：
SessionManager → Store.getMessages → new Agent(initialMessages)
              → subscribe(SessionListener) → subscribe(CLI)

运行：
Loop 追加完整消息 → message_end
                → Agent 更新实时 State
                → SessionListener 等待 appendMessage
                → CLI 监听器
~~~

Agent 管“执行”；Store 管“怎么保存”；工厂管“把两者接起来”。
Store 不保存整个 AgentState：isRunning、partial、pendingToolCalls 都是临时状态，重启不应恢复成“还在运行”。

断点放在 createSessionAgent 的 getMessages、Agent.handleEvent、SessionListener 的 appendMessage、JsonlSessionStore 的 appendFile。

学习版限制：内存追加与磁盘追加不是原子事务。磁盘失败后应报告错误，修复后重新打开 Session，以磁盘记录为准；不要盲目 continue 以为一定能补齐丢失消息。reset 也只清内存，不能拿它代替 /new。
