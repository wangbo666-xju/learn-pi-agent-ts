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
import Agent from "../src/agent.ts";
import type {AssistantMessage, Tool} from "../src/types.ts";

test("不接 SessionStore 的 Agent 仍可完成普通问答", async () => {
    const agent = new Agent({
        llm: new FakeLlmClient([{role: "assistant", content: "回答"}]),
        tools: [],
    });
    const result = await agent.prompt("提问");
    assert.equal(result.reason, "completed");
    assert.deepEqual(agent.state.messages, [
        {role: "user", content: "提问"},
        {role: "assistant", content: "回答"},
    ]);
});

test("读取历史失败时工厂拒绝创建，不调用模型也不追加消息", async () => {
    const store = new MemorySessionStore({id: "read-error", createdAt: 0});
    store.getMessages = async () => { throw new Error("历史读取失败"); };
    const llm = new FakeLlmClient([]);
    await assert.rejects(createSessionAgent(store, {llm, tools: []}), /历史读取失败/);
    assert.equal(llm.requests.length, 0);
    assert.deepEqual(await store.getEntries(), []);
});

test("完整工具交互只保存四条消息，不保存流式片段和工具进度", async () => {
    const store = new MemorySessionStore({id: "tools", createdAt: 0});
    const call: AssistantMessage = {
        role: "assistant", content: "调用工具",
        toolCalls: [{id: "c1", name: "echo", arguments: {}}],
    };
    const tool: Tool = {
        name: "echo", description: "测试",
        parameters: {type: "object", properties: {}},
        async execute(_args, _signal, onUpdate) {
            await onUpdate?.({content: "50%"});
            return {content: "工具结果", details: {count: 1}};
        },
    };
    const llm = new FakeLlmClient([call, {role: "assistant", content: "完成"}]);
    const agent = await createSessionAgent(store, {llm, tools: [tool]});
    let updates = 0;
    agent.subscribe(async (event) => {
        if (event.type === "tool_execution_update") {
            updates++;
            // 进度时只保存了 user 和完整的 assistant(toolCalls)。
            assert.equal((await store.getMessages()).length, 2);
        }
    });
    assert.equal((await agent.prompt("开始")).reason, "completed");
    assert.equal(updates, 1);
    assert.deepEqual(await store.getMessages(), [
        {role: "user", content: "开始"},
        call,
        {role: "toolResult", toolCallId: "c1", content: "工具结果",
            isError: false, details: {count: 1}},
        {role: "assistant", content: "完成"},
    ]);
    assert.deepEqual((await store.getEntries()).map((entry) => entry.seq), [1, 2, 3, 4]);
    assert.equal(llm.requests.length, 2);
});

test("工具结果保存失败时不请求下一轮模型，并发布 error 收尾", async () => {
    const store = new MemorySessionStore({id: "tool-save-error", createdAt: 0});
    const append = store.appendMessage.bind(store);
    store.appendMessage = async (message) => {
        if (message.role === "toolResult") throw new Error("工具结果写入失败");
        return append(message);
    };
    const llm = new FakeLlmClient([{
        role: "assistant", content: "",
        toolCalls: [{id: "c1", name: "echo", arguments: {}}],
    }]);
    const agent = await createSessionAgent(store, {
        llm,
        tools: [{name: "echo", description: "测试",
            parameters: {type: "object", properties: {}},
            execute: async () => ({content: "结果"})}],
    });
    const events: AgentEvent[] = [];
    agent.subscribe((event) => { events.push(event); });
    await assert.rejects(agent.prompt("开始"), /工具结果写入失败/);
    await agent.waitForIdle();
    assert.equal(llm.requests.length, 1);
    assert.deepEqual((await store.getMessages()).map((message) => message.role), ["user", "assistant"]);
    assert.deepEqual(events.filter((event) => event.type === "agent_end").map((event) => event.reason), ["error"]);
    assert.equal(agent.state.isRunning, false);
    assert.equal(agent.state.streamingMessage, undefined);
    assert.equal(agent.state.pendingToolCalls.size, 0);
    assert.match(agent.state.errorMessage ?? "", /工具结果写入失败/);
});

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
