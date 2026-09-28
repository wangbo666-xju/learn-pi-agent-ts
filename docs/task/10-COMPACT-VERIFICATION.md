# Task 10：Compact 的恢复与异常验证

> 状态：测试已落地并通过自动化验收。先阅读 [Task 09](09-MANUAL-COMPACT.md) 的设计；下面代码保留为学习说明，实际测试以 test 目录为准。
> 本次使用 Fake LLM 和本地 HTTP 服务，没有调用真实模型或改写用户 Session。

### 本次验收记录

- `npm run check` 通过；全量 92 项自动化测试通过。
- 核心覆盖成功、重复压缩、JSONL 重开、工具配对、空摘要、网络失败、保存失败、取消、提交后取消及 v1 拒绝。
- CLI 覆盖双向互斥、收尾期间拒绝压缩、关闭后拒绝新操作、压缩失败后继续输入。
- 新增 `test/cli-compact-process.test.ts`：启动真实 main.ts，验证恢复后请求含摘要，并验证 abort、exit、EOF 和 SIGINT 处理路径取消请求且不保存摘要。SIGINT 使用测试 IPC 触发处理器，不代表完成终端按键体验验收。
- 两个新增测试文件均已加入 package.json 的默认测试列表。真实模型摘要质量、自动压缩和跨进程写入仍不在本轮验收范围内。

## 为什么需要这一步

一次摘要能返回文字，只能说明“模型能总结”。Compact 真正完成，还需要证明：新上下文正确、历史未删除、再次压缩不重复、失败不会覆盖可用会话。

```text
原始历史 → C1 → 新消息 → C2 → 重启
                       ↓
                 S2 + 最新保留消息
```

这份文档分为核心行为、JSONL、CLI 和适配器四组。它们属于同一次验收，不是四个新开发任务。

## 一、先验证摘要与上下文：test/compaction.test.ts

新建此文件，下面代码块按顺序追加到同一文件。使用真实 MemoryStore 和 Agent，Fake LLM 只替代外部模型。

### 1. 公共准备：三段对话，保留两段

```ts
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
```

这份数据中 `问题1/回答1` 被压缩；问题2起保留。默认两个分组，所以只有一两次用户输入时 `/compact` 跳过是正常的。

### 2. 压缩成功，并不删除原始历史

```ts
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
```

在第二次模型请求前打断点，你应该看到摘要，而不再看到问题1的原文作为独立消息。

### 3. 重复压缩：带旧摘要，只概括新变旧的部分

```ts
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
```

### 4. 错误与取消：不得应用半成品

```ts
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
```

最后一个测试的重点：取消不是事务回滚。一旦保存成功，内存必须与新的持久化结果一致。

### 5. 不拆工具配对、不掩盖已有历史异常

```ts
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
```

## 二、JSONL 恢复：追加到同一测试文件

将这些 import 放在文件顶部，不要放进函数：

```ts
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {JsonlSessionStore} from "../src/session/jsonl-session-store.ts";
```

### 1. 重启后与压缩后内存一致

```ts
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
```

### 2. 旧文件不偷偷升级，坏边界不默默丢历史

```ts
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
```

## 三、CLI：test/cli-runtime.test.ts 追加三个场景

复用现有 import，并在文件顶部增加下面三个 import。压缩回调使用人工 Promise 闸门，使测试不依赖等待若干毫秒。

```ts
import {compactSession} from "../src/compaction.ts";
import {MemorySessionStore} from "../src/session/memory-session-store.ts";
import {createSessionAgent} from "../src/session/create-session-agent.ts";
```

```ts
test("启动压缩后立即关闭，不启动摘要模型", async () => {
    const store = new MemorySessionStore({id: "immediate", createdAt: 0});
    for (let i = 0; i < 3; i++) {
        await store.appendMessage({role: "user", content: `任务${i}`});
        await store.appendMessage({role: "assistant", content: "完成"});
    }
    const llm = new FakeLlmClient([]);
    const agent = await createSessionAgent(store, {llm, tools: []});
    const runner = createCliRunner(agent, () => {},
        (signal) => compactSession(agent, store, llm, signal));
    runner.handleControl({type: "compact"});
    await runner.close();
    assert.equal(llm.requests.length, 0);
    assert.equal((await store.getEntries()).length, 6);
    assert.equal(runner.isBusy, false);
});

test("压缩占用 Runner，取消与 close 等到压缩收尾", async () => {
    const llm = new FakeLlmClient([]);
    const agent = new Agent({llm, tools: []});
    const output: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let seenSignal: AbortSignal | undefined;
    let calls = 0;
    const runner = createCliRunner(agent, (text) => { output.push(text); }, async (signal) => {
        calls++;
        seenSignal = signal;
        await gate;
        signal.throwIfAborted();
        return "完成";
    });
    runner.handleControl({type: "compact"});
    await Promise.resolve();
    try {
        assert.equal(runner.isBusy, true);
        assert.equal(agent.state.isRunning, false);
        runner.handleControl({type: "status"});
        assert.match(output.join(""), /"isCompacting":true/);
        assert.equal(runner.handleControl({type: "new"}), true);
        assert.equal(runner.handleControl({type: "resume", sessionId: "other"}), true);
        runner.startPrompt("不能执行");
        runner.handleControl({type: "compact"});
        runner.handleControl({type: "steer", text: "不能加入"});
        runner.handleControl({type: "followup", text: "不能加入"});
        assert.equal(calls, 1);
        assert.equal(llm.requests.length, 0);
        runner.handleControl({type: "abort"});
        assert.equal(seenSignal?.aborted, true);
    } finally {
        release();
        await runner.close();
    }
    assert.equal(runner.isBusy, false);
    assert.match(output.join(""), /压缩已取消/);
});

test("压缩报错后仍可提交普通 Prompt", async () => {
    const agent = new Agent({llm: new FakeLlmClient([{role: "assistant", content: "可继续"}]), tools: []});
    const output: string[] = [];
    const runner = createCliRunner(agent, (text) => { output.push(text); }, async () => {
        throw new Error("摘要服务失败");
    });
    runner.handleControl({type: "compact"});
    await runner.waitForIdle();
    assert.match(output.join(""), /摘要服务失败/);
    runner.startPrompt("继续");
    await runner.waitForIdle();
    assert.equal(agent.state.messages.at(-1)?.content, "可继续");
    await runner.close();
});
```

`test/cli-command.test.ts` 原解析测试中追加：

```ts
assert.deepEqual(parseCliCommand("/compact"), {type: "compact"});
```

## 四、模型请求：给适配器测试补一个真实边界

在 `test/real-llm.test.ts` 追加以下测试，复用文件现有的 assert、test、RealLlmClient import。它验证实际 HTTP body，而不是只看 Fake requests。

```ts
test("摘要请求省略工具、限制输出并拒绝截断响应", async () => {
    const previousFetch = globalThis.fetch;
    const names = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"];
    const saved = names.map((name) => process.env[name]);
    process.env.OPENAI_API_KEY = "test-only";
    process.env.OPENAI_BASE_URL = "https://example.test";
    process.env.OPENAI_MODEL = "test-model";
    let finishReason = "stop";
    globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        assert.equal(body.max_tokens, 2048);
        assert.equal("tools" in body, false);
        assert.equal("tool_choice" in body, false);
        return new Response(JSON.stringify({choices: [{
            finish_reason: finishReason,
            message: {content: "摘要"},
        }]}));
    };
    try {
        const client = new RealLlmClient();
        const reply = await client.chat([], [], {maxOutputTokens: 2048});
        assert.equal(reply.content, "摘要");
        finishReason = "length";
        await assert.rejects(client.chat([], [], {maxOutputTokens: 2048}), /长度上限/);
    } finally {
        globalThis.fetch = previousFetch;
        names.forEach((name, index) => {
            const value = saved[index];
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        });
    }
});
```

环境变量原来不存在时必须 delete，不赋值 undefined；避免把字符串 "undefined" 留给其他测试。此测试不访问真实网络。

## 五、已有测试要迁移哪里

1. `session-event-listener.test.ts` 的“读取历史失败”把 `store.getMessages = ...` 改为 `store.getEntries = ...`，故障注入点跟随新的恢复入口。最后用 `assert.deepEqual(await store.getMessages(), [])` 确认未追加消息，不再调用已注入故障的 getEntries。
2. 使用 `getEntries()` 结果访问 `.message` 时，先检查 `entry.type === "message"`；新增 compaction 后不能假定每条 Entry 都有 message。
3. 无压缩场景下的历史数量与 seq 测试应保持不变；不要为了通过测试删掉原断言。
4. Runner 拒绝提示若变化，测试匹配实际约定，不修改“必须拒绝”的行为断言。

## 六、运行顺序与验收

把 `test/compaction.test.ts` 和 `test/cli-compact-process.test.ts` 追加到 package.json 的 scripts.test，保留全部原测试（已完成）。

```powershell
npx tsx --test test/compaction.test.ts test/cli-runtime.test.ts test/cli-command.test.ts test/real-llm.test.ts test/session-event-listener.test.ts
npm run check
npm test
git diff --check
```

初次运行应暴露新模块/方法缺失；实现后应全部通过。Node strip-only 导入新模块时不能出现参数属性、运行时类型导入等错误。

真实手工验证（会使用模型配额）：

| 操作 | 观察 |
|---|---|
| /new，新建至少三次用户输入 | v2 会话、有足够旧分组 |
| 第一条说明“禁止新增依赖”，后续讨论项目 | 形成需要保留的长期约束 |
| /compact，然后 /status | 压缩期间 isCompacting=true；不阻塞命令输入 |
| 压缩中 /new、/skill:某名称 要求 | 不能切会话或启动模型任务 |
| 压缩中 /abort、再次开始压缩 | 取消后释放状态，可重新操作 |
| 压缩完成后询问项目约束 | 检查实际请求含摘要，回答仅作辅助观察 |
| 立即再次 /compact | 没有新增可压缩内容，不请求摘要模型 |
| 继续几次对话，再 /compact | 旧摘要进入更新请求 |
| 退出，/resume 原 ID | 有效上下文恢复一致，原历史完整 |
| 恢复 v1 后尝试 /compact | 明确拒绝、不改变旧文件；可 /new 体验 |

模型摘要可能漏信息，因此不能只凭一次回答“记住约束了”证明绝对正确。检查请求消息、边界 ID、JSONL 记录三者是否一致。

## 学完后你应该能自己回答

- 为什么 getMessages 与 buildAgentContext 不能混为一谈？
- 为什么 C1 出现在 M100 后，却仍然保留 M81？
- 为什么压缩摘要不经过普通 Agent Loop？
- 为什么取消检查放在保存之前，而不是保存之后直接 return？
- 为什么压缩时 Agent.isRunning=false，CLI 仍然必须判忙？

当这五个问题能解释清楚，手动 Compact 的学习目标就达到了；自动阈值属于下一阶段。
