import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {JsonlSessionStore} from "../src/session/jsonl-session-store.ts";

import assert from "node:assert/strict";
import test from "node:test";
import {FakeLlmClient} from "../src/fake-llm.ts";
import {compactSession, prepareCompaction} from "../src/compaction.ts";
import {MemorySessionStore} from "../src/session/memory-session-store.ts";
import {createSessionAgent} from "../src/session/create-session-agent.ts";
import {buildAgentContext} from "../src/session/build-agent-context.ts";
import type {SessionStore} from "../src/session/session-store.ts";

async function seed(store: SessionStore): Promise<void> {
    for (let i = 1; i <= 3; i++) {
        await store.appendMessage({role: "user", content: `问题${i}`});
        await store.appendMessage({role: "assistant", content: `回答${i}`});
    }
}

test("压缩后保留原历史，下一次请求使用摘要和近期消息", async () => {
    const store = new MemorySessionStore({id: "compact", createdAt: 0});
    await seed(store);
    const llm = new FakeLlmClient([
        {role: "assistant", content: "S1：已处理问题1"},
        {role: "assistant", content: "继续完成"},
    ]);
    const agent = await createSessionAgent(store, {llm, tools: []});
    await compactSession(agent, store, llm, new AbortController().signal);
    assert.equal((await store.getMessages()).length, 6);
    assert.equal((await store.getEntries()).length, 7);
    assert.equal(agent.state.messages.length, 5); // 摘要 + 两组共四条消息
    assert.match(agent.state.messages[0]!.content, /S1/);
    assert.equal(agent.state.messages[1]!.content, "问题2");
    assert.deepEqual(llm.requests[0]!.toolNames, []);
    await agent.prompt("继续");
    assert.match(llm.requests[1]!.messages[0]!.content, /S1/);
    assert.equal(llm.requests[1]!.messages.at(-1)!.content, "继续");
    // 六条原始消息 + 新的 user/assistant；合成摘要没有落成普通 message。
    assert.equal((await store.getMessages()).length, 8);
});

test("第二次压缩更新旧摘要，无新增旧分组时直接跳过", async () => {
    const store = new MemorySessionStore({id: "repeat", createdAt: 0});
    await seed(store);
    const llm = new FakeLlmClient([
        {role: "assistant", content: "S1"},
        {role: "assistant", content: "回答4"},
        {role: "assistant", content: "S2"},
    ]);
    const agent = await createSessionAgent(store, {llm, tools: []});
    const signal = new AbortController().signal;
    await compactSession(agent, store, llm, signal);
    await compactSession(agent, store, llm, signal);
    assert.equal(llm.requests.length, 1); // 立即再压缩，不调用模型
    await agent.prompt("问题4");
    await compactSession(agent, store, llm, signal);
    const request = llm.requests[2]!.messages[0]!.content;
    assert.match(request, /S1/);
    assert.match(request, /问题2/);
    assert.equal(request.includes("问题1"), false);
    const context = buildAgentContext(await store.getEntries());
    assert.match(context[0]!.content, /S2/);
    assert.equal(context[1]!.content, "问题3");
    assert.deepEqual(context, agent.state.messages);
});

test("空摘要与意外工具调用被拒绝", async () => {
    for (const reply of [
        {role: "assistant" as const, content: "   "},
        {role: "assistant" as const, content: "摘要", toolCalls: [
            {id: "c1", name: "write", arguments: {}},
        ]},
    ]) {
        const store = new MemorySessionStore({id: "invalid", createdAt: 0});
        await seed(store);
        const llm = new FakeLlmClient([reply]);
        const agent = await createSessionAgent(store, {llm, tools: []});
        const before = structuredClone(agent.state.messages);
        await assert.rejects(compactSession(agent, store, llm, new AbortController().signal));
        assert.deepEqual(agent.state.messages, before);
        assert.equal((await store.getEntries()).length, 6);
    }
});

test("生成摘要失败不修改上下文或 Entry", async () => {
    const store = new MemorySessionStore({id: "network", createdAt: 0});
    await seed(store);
    const llm = new FakeLlmClient([]);
    llm.chat = async () => { throw new Error("网络失败"); };
    const agent = await createSessionAgent(store, {llm, tools: []});
    const before = structuredClone(agent.state.messages);
    await assert.rejects(compactSession(agent, store, llm, new AbortController().signal), /网络失败/);
    assert.deepEqual(agent.state.messages, before);
    assert.equal((await store.getEntries()).length, 6);
});

test("LLM 返回时已经取消，不保存摘要", async () => {
    const store = new MemorySessionStore({id: "cancel", createdAt: 0});
    await seed(store);
    const controller = new AbortController();
    const llm = new FakeLlmClient([]);
    llm.chat = async () => {
        controller.abort();
        return {role: "assistant", content: "不应保存"};
    };
    const agent = await createSessionAgent(store, {llm, tools: []});
    const before = structuredClone(agent.state.messages);
    await assert.rejects(compactSession(agent, store, llm, controller.signal));
    assert.deepEqual(agent.state.messages, before);
    assert.equal((await store.getEntries()).length, 6);
});

test("落盘失败不替换内存；提交成功后取消仍应用摘要", async () => {
    const store = new MemorySessionStore({id: "commit", createdAt: 0});
    await seed(store);
    const llm = new FakeLlmClient([
        {role: "assistant", content: "S1"}, {role: "assistant", content: "S2"},
    ]);
    const agent = await createSessionAgent(store, {llm, tools: []});
    const before = structuredClone(agent.state.messages);
    const append = store.appendCompaction.bind(store);
    store.appendCompaction = async () => { throw new Error("磁盘失败"); };
    await assert.rejects(compactSession(agent, store, llm, new AbortController().signal), /磁盘失败/);
    assert.deepEqual(agent.state.messages, before);
    assert.equal((await store.getEntries()).length, 6);
    const controller = new AbortController();
    store.appendCompaction = async (input) => {
        const result = await append(input);
        controller.abort();
        return result;
    };
    await compactSession(agent, store, llm, controller.signal);
    assert.match(agent.state.messages[0]!.content, /S2/);
    assert.deepEqual(agent.state.messages, buildAgentContext(await store.getEntries()));
});

test("工具调用与结果整体保留；孤立结果拒绝压缩", async () => {
    const store = new MemorySessionStore({id: "tools", createdAt: 0});
    await store.appendMessage({role: "user", content: "旧任务"});
    await store.appendMessage({role: "assistant", content: "旧任务完成"});
    await store.appendMessage({role: "user", content: "读文件"});
    await store.appendMessage({role: "assistant", content: "", toolCalls: [
        {id: "read1", name: "read", arguments: {path: "a.txt"}},
    ]});
    await store.appendMessage({role: "toolResult", toolCallId: "read1", content: "内容", isError: false});
    await store.appendMessage({role: "assistant", content: "读取完成"});
    const entries = await store.getEntries();
    const preparation = prepareCompaction(entries, 1)!;
    assert.equal(preparation.firstKeptEntryId, entries[2]!.id);
    assert.equal(preparation.messagesToSummarize.length, 2);
    await store.appendMessage({role: "toolResult", toolCallId: "missing", content: "孤立", isError: true});
    const broken = await store.getEntries();
    assert.throws(() => prepareCompaction(broken), /孤立工具结果/);
});

test("JSONL 重开可恢复压缩，原消息和 seq 保留", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "compact-test-"));
    t.after(() => rm(dir, {recursive: true, force: true}));
    const file = join(dir, "session.jsonl");
    const store = await JsonlSessionStore.create(file, {id: "disk", createdAt: 0});
    await seed(store);
    const llm = new FakeLlmClient([
        {role: "assistant", content: "S1"},
        {role: "assistant", content: "回答4"},
        {role: "assistant", content: "S2"},
        {role: "assistant", content: "回答5"},
    ]);
    const agent = await createSessionAgent(store, {llm, tools: []});
    await compactSession(agent, store, llm, new AbortController().signal);
    const reopened = await JsonlSessionStore.open(file);
    const restored = await createSessionAgent(reopened, {llm, tools: []});
    assert.deepEqual(restored.state.messages, agent.state.messages);
    assert.equal((await reopened.getMessages()).length, 6);
    assert.deepEqual((await reopened.getEntries()).map((entry) => entry.seq), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal((await readFile(file, "utf8")).trim().split(/\r?\n/).length, 8);
    // 之后仅由 restored/reopened 写文件，避免两个 Store 实例并发写同一个 JSONL。
    await restored.prompt("问题4");
    await compactSession(restored, reopened, llm, new AbortController().signal);
    await restored.prompt("问题5");
    const twice = await JsonlSessionStore.open(file);
    assert.deepEqual(buildAgentContext(await twice.getEntries()), restored.state.messages);
    assert.match(restored.state.messages[0]!.content, /S2/);
    assert.equal(restored.state.messages[1]!.content, "问题3");
    assert.equal(restored.state.messages.at(-1)!.content, "回答5");
    assert.equal((await twice.getMessages()).length, 10);
    assert.equal((await twice.getEntries()).filter((entry) => entry.type === "compaction").length, 2);
});

test("v1 可读但拒绝压缩；无效边界不追加", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "compact-v1-"));
    t.after(() => rm(dir, {recursive: true, force: true}));
    const file = join(dir, "old.jsonl");
    await writeFile(file, JSON.stringify({type: "session", version: 1, id: "old", createdAt: 0}) + "\n");
    const old = await JsonlSessionStore.open(file);
    await seed(old);
    const before = await readFile(file, "utf8");
    const llm = new FakeLlmClient([]);
    const agent = await createSessionAgent(old, {llm, tools: []});
    await assert.rejects(compactSession(agent, old, llm, new AbortController().signal), /v1/);
    assert.equal(llm.requests.length, 0);
    await assert.rejects(old.appendCompaction({summary: "S", firstKeptEntryId: "none"}), /v1/);
    assert.equal(await readFile(file, "utf8"), before);
    const memory = new MemorySessionStore({id: "invalid-ref", createdAt: 0});
    await seed(memory);
    await assert.rejects(memory.appendCompaction({summary: "S", firstKeptEntryId: "none"}), /user/);
    assert.equal((await memory.getEntries()).length, 6);
});
