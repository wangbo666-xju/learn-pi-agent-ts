import assert from "node:assert/strict";
import test from "node:test";
import Agent from "../src/agent.ts";
import type {AgentEvent} from "../src/agent-events.ts";
import {FakeLlmClient} from "../src/fake-llm.ts";
import {MemorySessionStore} from "../src/session/memory-session-store.ts";
import type {
    AgentMessage,
    AssistantMessage,
    LlmClient,
    LlmRequestOptions,
    LlmStreamListener,
    Tool,
} from "../src/types.ts";

function createStore(): MemorySessionStore {
    return new MemorySessionStore({id: "test", createdAt: 0});
}

class BlockingLlm implements LlmClient {
    async chat(): Promise<AssistantMessage> {
        throw new Error("测试只允许调用 chatStream");
    }

    async chatStream(
        _messages: AgentMessage[],
        _tools: Tool[],
        onEvent: LlmStreamListener,
        options?: LlmRequestOptions,
    ): Promise<AssistantMessage> {
        const signal = options?.signal;
        if (!signal) throw new Error("没有收到 AbortSignal");

        await onEvent({
            type: "start",
            partial: {role: "assistant", content: ""},
        });
        await onEvent({
            type: "text_delta",
            delta: "partial",
            partial: {role: "assistant", content: "partial"},
        });

        await new Promise<void>((_resolve, reject) => {
            if (signal.aborted) {
                reject(signal.reason);
                return;
            }
            signal.addEventListener("abort", () => reject(signal.reason), {once: true});
        });
        throw new Error("此测试 LLM 只能通过取消结束");
    }
}

test("运行锁立即生效，取消后清理 partial，waitForIdle 等到收尾", async () => {
    const store = createStore();
    const agent = new Agent({llm: new BlockingLlm(), tools: [], sessionStore: store});
    const events: AgentEvent[] = [];
    let idleCompleted = false;
    agent.subscribe((event) => {
        events.push(structuredClone(event));
        if (event.type === "message_update") {
            assert.equal(agent.state.streamingMessage?.content, "partial");
            assert.equal(idleCompleted, false);
            agent.abort();
        }
    });

    const run = agent.prompt("开始");
    assert.equal(agent.state.isRunning, true);
    const idle = agent.waitForIdle().then(() => { idleCompleted = true; });
    await assert.rejects(agent.prompt("重复"), /already running/);
    const result = await run;
    await idle;

    assert.equal(result.reason, "aborted");
    assert.equal(agent.state.isRunning, false);
    assert.equal(agent.state.streamingMessage, undefined);
    assert.equal(agent.state.pendingToolCalls.size, 0);
    assert.equal(idleCompleted, true);
    assert.equal(events.filter((event) => event.type === "agent_end").length, 1);
    assert.deepEqual(await store.getMessages(), [{role: "user", content: "开始"}]);
});

test("失败后 waitForIdle 不抛错，并可 continue 恢复", async () => {
    const llm = new FakeLlmClient([{role: "assistant", content: "恢复成功"}]);
    let fail = true;
    const agent = new Agent({
        llm, tools: [], sessionStore: createStore(),
        transformContext: async (messages) => {
            if (fail) {
                fail = false;
                throw new Error("上下文处理失败");
            }
            return messages;
        },
    });
    await assert.rejects(agent.prompt("开始"), /上下文处理失败/);
    await agent.waitForIdle();
    assert.equal(agent.state.isRunning, false);
    assert.match(agent.state.errorMessage ?? "", /上下文处理失败/);

    const result = await agent.continue();
    assert.equal(result.finalMessage?.content, "恢复成功");
    assert.equal(agent.state.errorMessage, undefined);
    assert.deepEqual(llm.requests[0]?.messages, [{role: "user", content: "开始"}]);
});

test("steer 优先于工具后续请求，followUp 等当前任务结束", async () => {
    const llm = new FakeLlmClient([
        {
            role: "assistant", content: "",
            toolCalls: [{id: "c1", name: "echo", arguments: {}}],
        },
        {role: "assistant", content: "当前任务完成"},
        {role: "assistant", content: "总结完成"},
    ]);
    const tool: Tool = {
        name: "echo", description: "测试",
        parameters: {type: "object", properties: {}},
        async execute() { return {content: "工具结果"}; },
    };
    const agent = new Agent({llm, tools: [tool], sessionStore: createStore()});
    agent.subscribe((event) => {
        if (event.type === "turn_end" && event.turn === 1) {
            agent.followUp({role: "user", content: "最后总结"});
            agent.steer({role: "user", content: "改为只读"});
        }
    });
    const result = await agent.prompt("开始");
    assert.equal(result.reason, "completed");
    assert.equal(llm.requests.length, 3);
    assert.equal(llm.requests[1]?.messages.at(-1)?.content, "改为只读");
    assert.equal(llm.requests[2]?.messages.at(-1)?.content, "最后总结");
    assert.deepEqual(agent.state.messages.map((message) => message.role), [
        "user", "assistant", "toolResult", "user", "assistant", "user", "assistant",
    ]);
});

test("shouldStopAfterTurn 优先于待处理队列", async () => {
    const llm = new FakeLlmClient([{role: "assistant", content: "回答"}]);
    const agent = new Agent({
        llm, tools: [], sessionStore: createStore(),
        shouldStopAfterTurn: () => true,
    });
    agent.steer({role: "user", content: "新方向"});
    agent.followUp({role: "user", content: "后续"});
    const result = await agent.prompt("开始");
    assert.equal(result.reason, "terminated");
    assert.equal(llm.requests.length, 1);
    assert.deepEqual(agent.state.messages.map((message) => message.content), ["开始", "回答"]);
});

test("最后一轮直接回答属于 completed", async () => {
    const agent = new Agent({
        llm: new FakeLlmClient([{role: "assistant", content: "回答"}]),
        tools: [], sessionStore: createStore(), maxTurns: 1,
    });
    assert.equal((await agent.prompt("开始")).reason, "completed");
});

test("轮数耗尽后从 toolResult 继续，新的 Run 使用新的预算", async () => {
    const llm = new FakeLlmClient([
        {
            role: "assistant", content: "",
            toolCalls: [{id: "c1", name: "missing", arguments: {}}],
        },
        {role: "assistant", content: "解释工具错误"},
    ]);
    const agent = new Agent({llm, tools: [], sessionStore: createStore(), maxTurns: 1});
    const first = await agent.prompt("开始");
    assert.equal(first.reason, "max_turns");
    assert.equal(agent.state.messages.at(-1)?.role, "toolResult");
    const second = await agent.continue();
    assert.equal(second.reason, "completed");
    assert.equal(second.finalMessage?.content, "解释工具错误");
});

test("空历史和无队列的 assistant 不能 continue", async () => {
    const agent = new Agent({
        llm: new FakeLlmClient([{role: "assistant", content: "回答"}]),
        tools: [], sessionStore: createStore(),
    });
    await assert.rejects(agent.continue(), /没有可继续/);
    await agent.prompt("开始");
    await assert.rejects(agent.continue(), /assistant/);
});

for (const queue of ["steer", "followUp"] as const) {
    test("assistant 结尾可用 " + queue + " 队列继续", async () => {
        const llm = new FakeLlmClient([
            {role: "assistant", content: "第一次"},
            {role: "assistant", content: "第二次"},
        ]);
        const agent = new Agent({llm, tools: [], sessionStore: createStore()});
        await agent.prompt("开始");
        agent[queue]({role: "user", content: "继续要求"});
        const result = await agent.continue();
        assert.equal(result.reason, "completed");
        assert.equal(llm.requests[1]?.messages.at(-1)?.content, "继续要求");
    });
}

test("message_end 订阅者失败仍结束且只发布一次 agent_end", async () => {
    const agent = new Agent({
        llm: new FakeLlmClient([]), tools: [], sessionStore: createStore(),
    });
    let ends = 0;
    agent.subscribe((event) => {
        if (event.type === "message_end") throw new Error("监听器失败");
        if (event.type === "agent_end") ends++;
    });
    await assert.rejects(agent.prompt("开始"), /监听器失败/);
    await agent.waitForIdle();
    assert.equal(ends, 1);
    assert.equal(agent.state.isRunning, false);
});

test("reset 清空内存与队列，但不删除 Store 的历史", async () => {
    const store = createStore();
    const agent = new Agent({
        llm: new FakeLlmClient([{role: "assistant", content: "回答"}]),
        tools: [], sessionStore: store,
    });
    await agent.prompt("开始");
    agent.steer({role: "user", content: "队列"});
    agent.reset();
    assert.deepEqual(agent.state.messages, []);
    assert.equal((await store.getMessages()).length, 2);
    await assert.rejects(agent.continue(), /没有可继续/);
});

/**
 * 回归：最后一轮回答后，保存 steer 消息期间发生取消。
 * 即使预算已经耗尽，取消也应优先返回 aborted，而不是 max_turns。
 */
test("预算耗尽后注入 steer 时取消，应优先返回 aborted", async () => {
    const llm = new FakeLlmClient([{role: "assistant", content: "第一轮完成"}]);
    const store = createStore();
    const agent = new Agent({llm, tools: [], sessionStore: store, maxTurns: 1});
    const events: AgentEvent[] = [];

    agent.steer({role: "user", content: "改变方向"});
    agent.subscribe((event) => {
        events.push(structuredClone(event));
        if (
            event.type === "message_end" &&
            event.message.role === "user" &&
            event.message.content === "改变方向"
        ) {
            agent.abort();
        }
    });

    const result = await agent.prompt("开始");
    await agent.waitForIdle();

    assert.equal(result.reason, "aborted");
    assert.equal(llm.requests.length, 1);
    assert.deepEqual(
        events.filter((event) => event.type === "agent_end").map((event) => event.reason),
        ["aborted"],
    );
    assert.equal(agent.state.isRunning, false);
    assert.equal(agent.state.streamingMessage, undefined);
    assert.equal(agent.state.pendingToolCalls.size, 0);
    assert.deepEqual(await store.getMessages(), [
        {role: "user", content: "开始"},
        {role: "assistant", content: "第一轮完成"},
        {role: "user", content: "改变方向"},
    ]);
});
