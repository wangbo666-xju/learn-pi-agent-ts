import assert from "node:assert/strict";
import test from "node:test";
import {FakeLlmClient} from "../src/fake-llm.ts";
import {ContextOverflowError} from "../src/llm-usage.ts";
import {estimateContextTokens, validateAutoCompact} from "../src/context-budget.ts";
import {createSessionRuntime} from "../src/session/session-runtime.ts";
import {MemorySessionStore} from "../src/session/memory-session-store.ts";
import {buildAgentContext} from "../src/session/build-agent-context.ts";
import type {SessionStore} from "../src/session/session-store.ts";
import type {AssistantMessage, LlmClient} from "../src/types.ts";
import {createCliRunner} from "../src/cli-agent-runner.ts";

const limits = {contextWindowTokens: 1000, reserveTokens: 200};
const high: AssistantMessage = {role: "assistant", content: "旧回答", usage: {
    input: 850, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 900,
}};
async function seed(store: SessionStore, withUsage = true) {
    for (let i = 1; i <= 3; i++) {
        await store.appendMessage({role: "user", content: `问题${i}`});
        await store.appendMessage(withUsage ? high : {role: "assistant", content: "旧回答"});
    }
}

test("usage 基线加增量；压缩前和不同配置的 usage 不复用", async () => {
    const store = new MemorySessionStore({id: "estimate", createdAt: 0});
    await seed(store);
    assert.equal(estimateContextTokens(await store.getEntries()), 900);
    await store.appendMessage({role: "user", content: "abcd"});
    assert.ok(estimateContextTokens(await store.getEntries())! > 900);
    assert.equal(estimateContextTokens(await store.getEntries(), "changed-model"), undefined);
    const entries = await store.getEntries();
    await store.appendCompaction({summary: "S", firstKeptEntryId: entries[4]!.id});
    assert.equal(estimateContextTokens(await store.getEntries()), undefined);
    for (const config of [{...limits, reserveTokens: 1000}, {...limits, contextWindowTokens: NaN}, {...limits, reserveTokens: -1}]) {
        assert.throws(() => validateAutoCompact(config));
    }
});

test("恢复后先压缩再添加输入；当前结果和完整原历史均保留", async () => {
    const store = new MemorySessionStore({id: "before", createdAt: 0});
    await seed(store);
    const llm = new FakeLlmClient([{role: "assistant", content: "S1"}, {role: "assistant", content: "新回答"}]);
    const runtime = await createSessionRuntime(store, {llm, tools: [], autoCompact: limits});
    const result = await runtime.prompt("新问题");
    assert.equal(llm.requests.length, 2);
    assert.match(llm.requests[1]!.messages[0]!.content, /S1/);
    assert.equal(llm.requests[1]!.messages.at(-1)!.content, "新问题");
    assert.deepEqual(result.newMessages.map((m) => m.content), ["新问题", "新回答"]);
    assert.equal((await store.getMessages()).length, 8);
    assert.deepEqual(runtime.state.messages, buildAgentContext(await store.getEntries()));
    assert.equal(runtime.isCompacting, false);
});

test("任务结束后压缩，不重复回复；新鲜 usage 缺失时不反复压缩", async () => {
    const store = new MemorySessionStore({id: "after", createdAt: 0});
    await seed(store, false);
    const llm = new FakeLlmClient([high, {role: "assistant", content: "S1"}, {role: "assistant", content: "继续完成"}]);
    const runtime = await createSessionRuntime(store, {llm, tools: [], autoCompact: limits});
    assert.equal((await runtime.prompt("问题4")).finalMessage?.content, "旧回答");
    assert.match(runtime.state.messages[0]!.content, /S1/);
    await runtime.prompt("问题5");
    assert.equal(llm.requests.length, 3);
    assert.equal((await store.getEntries()).filter((e) => e.type === "compaction").length, 1);
});

test("工具续跑溢出后压缩并 continue，不重复执行工具或追加 user", async () => {
    const store = new MemorySessionStore({id: "recover", createdAt: 0});
    await seed(store, false);
    let executions = 0;
    const llm = new FakeLlmClient([
        {role: "assistant", content: "", toolCalls: [{id: "c", name: "write", arguments: {}}]},
        {role: "assistant", content: "S1"},
        {role: "assistant", content: "最终完成"},
    ]);
    const stream = llm.chatStream.bind(llm);
    let requests = 0;
    llm.chatStream = async (...args) => {
        if (++requests === 2) throw new ContextOverflowError("上下文溢出");
        return stream(...args);
    };
    const runtime = await createSessionRuntime(store, {llm, autoCompact: limits, tools: [{
        name: "write", description: "测试工具", parameters: {type: "object"},
        execute: async () => { executions++; return {content: "已写入"}; },
    }]});
    const result = await runtime.prompt("写入一次");
    assert.equal(executions, 1);
    assert.equal(requests, 3);
    assert.equal(result.reason, "completed");
    assert.deepEqual(result.newMessages.map((m) => m.role), ["user", "assistant", "toolResult", "assistant"]);
    assert.equal((await store.getMessages()).filter((m) => m.content === "写入一次").length, 1);
    const continued = llm.requests.at(-1)!.messages;
    assert.equal(continued.at(-1)!.role, "toolResult");
    assert.ok(continued.some((m) => m.role === "assistant" && m.toolCalls?.[0]?.id === "c"));
});

test("溢出只恢复一次；无旧分组和普通网络失败不重试", async () => {
    for (const kind of ["overflow", "empty", "network", "disabled"]) {
        const store = new MemorySessionStore({id: kind, createdAt: 0});
        if (kind !== "empty") await seed(store, false);
        const llm = new FakeLlmClient([{role: "assistant", content: "S"}]);
        let requests = 0;
        llm.chatStream = async () => {
            requests++;
            throw kind === "network" ? new Error("fetch failed") : new ContextOverflowError("overflow");
        };
        const runtime = await createSessionRuntime(store, {llm, tools: [], autoCompact: kind === "disabled" ? undefined : limits});
        await assert.rejects(runtime.prompt("继续"));
        assert.equal(requests, kind === "overflow" ? 2 : 1);
        assert.equal(llm.requests.length, kind === "overflow" ? 1 : 0);
    }
});

test("自动摘要期间 CLI 可查看状态、拒绝切会话，退出取消并等待收尾", {timeout: 5000}, async () => {
    const store = new MemorySessionStore({id: "abort", createdAt: 0});
    await seed(store);
    const llm: LlmClient = new FakeLlmClient([]);
    let startSummary: () => void = () => {};
    let finishSummary: () => void = () => {};
    const started = new Promise<void>((resolve) => { startSummary = resolve; });
    const finished = new Promise<void>((resolve) => { finishSummary = resolve; });
    llm.chat = async (_messages, _tools, options) => {
        startSummary();
        await new Promise<void>((resolve) => options!.signal!.addEventListener("abort", () => resolve(), {once: true}));
        finishSummary();
        return {role: "assistant", content: "不能保存"};
    };
    const runtime = await createSessionRuntime(store, {llm, tools: [], autoCompact: limits});
    const output: string[] = [];
    const runner = createCliRunner(runtime, (s) => { output.push(s); }, (signal) => runtime.compact(signal));
    runner.startPrompt("还没保存的输入");
    await started;
    assert.throws(() => runtime.steer({role: "user", content: "不能悄悄留到下一次任务"}), /正在压缩/);
    assert.throws(() => runtime.followUp({role: "user", content: "也不能排队"}), /正在压缩/);
    runner.handleControl({type: "status"});
    assert.ok(output.some((line) => line.includes('"isCompacting":true')));
    assert.equal(runner.handleControl({type: "new"}), true);
    await runner.close();
    await finished;
    assert.equal(runtime.isCompacting, false);
    assert.equal(runner.isBusy, false);
    assert.equal((await store.getEntries()).length, 6);
});

test("保存失败后在错误收尾时取消，仍报告原始磁盘失败而不是取消成功", async () => {
    const store = new MemorySessionStore({id: "disk-abort", createdAt: 0});
    store.appendMessage = async () => { throw new Error("磁盘保存失败"); };
    const runtime = await createSessionRuntime(store, {llm: new FakeLlmClient([]), tools: [], autoCompact: limits});
    runtime.subscribe((event) => {
        if (event.type === "agent_end" && event.reason === "error") runtime.abort();
    });
    await assert.rejects(runtime.prompt("不能保存的输入"), /磁盘保存失败/);
    await runtime.waitForIdle();
    assert.equal(runtime.state.isRunning, false);
});

test("手动压缩期间 Session 公共接口也拒绝排队，不能延迟到不相关任务", async () => {
    const store = new MemorySessionStore({id: "manual-queue", createdAt: 0});
    await seed(store);
    const llm: LlmClient = new FakeLlmClient([]);
    const runtime = await createSessionRuntime(store, {llm, tools: []});
    llm.chat = async () => {
        assert.throws(() => runtime.steer({role: "user", content: "拒绝"}), /正在压缩/);
        assert.throws(() => runtime.followUp({role: "user", content: "拒绝"}), /正在压缩/);
        return {role: "assistant", content: "S"};
    };
    await runtime.compact();
    assert.equal(runtime.isCompacting, false);
});

test("只有近期分组时跳过摘要，不发布虚假的压缩完成事件", async () => {
    const store = new MemorySessionStore({id: "short", createdAt: 0});
    const llm = new FakeLlmClient([high]);
    const events: string[] = [];
    const runtime = await createSessionRuntime(store, {llm, tools: [], autoCompact: limits,
        onCompaction: (event) => { events.push(event.type); },
    });
    await runtime.prompt("只有一组");
    assert.equal(llm.requests.length, 1);
    assert.deepEqual(events, []);
    assert.equal(runtime.isCompacting, false);
});

test("压缩提交失败不替换内存；提交后取消必须应用新上下文且不发出新请求", async () => {
    for (const fail of [true, false]) {
        const store = new MemorySessionStore({id: "commit", createdAt: 0});
        await seed(store);
        const llm = new FakeLlmClient([{role: "assistant", content: "S"}, {role: "assistant", content: "正常回答"}]);
        const runtime = await createSessionRuntime(store, {llm, tools: [], autoCompact: limits});
        const append = store.appendCompaction.bind(store);
        store.appendCompaction = async (input) => {
            if (fail) throw new Error("磁盘写入失败");
            const entry = await append(input);
            runtime.abort();
            return entry;
        };
        const result = await runtime.prompt("下一步");
        assert.deepEqual(runtime.state.messages, buildAgentContext(await store.getEntries()));
        if (fail) {
            assert.equal((await store.getEntries()).some((e) => e.type === "compaction"), false);
            assert.equal(result.finalMessage?.content, "正常回答");
        } else {
            assert.equal(result.reason, "aborted");
            assert.equal(llm.requests.length, 1);
            assert.match(runtime.state.messages[0]!.content, /S/);
            assert.equal((await store.getMessages()).length, 6);
        }
    }
});

test("Session 同步互斥且立即取消有效，取消后允许下一次 prompt", async () => {
    const store = new MemorySessionStore({id: "lock", createdAt: 0});
    const llm = new FakeLlmClient([{role: "assistant", content: "完成"}]);
    const runtime = await createSessionRuntime(store, {llm, tools: [], autoCompact: limits});
    const first = runtime.prompt("取消的任务");
    await assert.rejects(runtime.prompt("重入"), /正在运行/);
    runtime.abort();
    assert.equal((await first).reason, "aborted");
    await runtime.waitForIdle();
    await runtime.prompt("新任务");
    assert.equal((await store.getMessages()).at(-1)!.content, "完成");
});

test("后台阈值摘要失败不丢掉已经完成的回答，错误通过压缩事件报告", async () => {
    const store = new MemorySessionStore({id: "failure", createdAt: 0});
    await seed(store, false);
    const llm = new FakeLlmClient([high]);
    const stream = llm.chatStream.bind(llm);
    const events: string[] = [];
    llm.chatStream = async (...args) => {
        const result = await stream(...args);
        llm.chat = async () => { throw new Error("摘要网络失败"); };
        return result;
    };
    const runtime = await createSessionRuntime(store, {llm, tools: [], autoCompact: limits,
        onCompaction: (event) => { events.push(JSON.stringify(event)); },
    });
    const result = await runtime.prompt("问题4");
    assert.equal(result.reason, "completed");
    assert.equal(result.finalMessage?.content, "旧回答");
    assert.ok(events.some((e) => e.includes("摘要网络失败")));
    assert.equal((await store.getEntries()).length, 8);
});
