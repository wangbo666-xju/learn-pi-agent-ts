import assert from "node:assert/strict";
import test from "node:test";
import Agent from "../src/agent.ts";
import {FakeLlmClient} from "../src/fake-llm.ts";
import {createCliRunner} from "../src/cli-agent-runner.ts";

test("agent_end 监听器尚未完成时仍禁止切会话", async () => {
    const agent = new Agent({llm: new FakeLlmClient([{role: "assistant", content: "完成"}]), tools: []});
    const output: string[] = [];
    const runner = createCliRunner(agent, (text) => { output.push(text); });
    let notifyEntered: () => void = () => {};
    let release: () => void = () => {};
    const entered = new Promise<void>((resolve) => { notifyEntered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    agent.subscribe(async (event) => {
        if (event.type === "agent_end") {
            notifyEntered();
            await gate;
        }
    });
    runner.startPrompt("开始");
    await entered;
    try {
        assert.equal(agent.state.isRunning, false);
        assert.equal(runner.isBusy, true);
        assert.equal(runner.handleControl({type: "new"}), true);
        assert.equal(runner.handleControl({type: "resume", sessionId: "other"}), true);
        runner.handleControl({type: "status"});
        assert.match(output.join(""), /"isSettling":true/);
    } finally {
        release();
        await runner.close();
    }
    assert.equal(runner.isBusy, false);
});

test("运行中能 abort/status，不能切会话或启动第二个 Prompt", async () => {
    const llm = new FakeLlmClient([]);
    const agent = new Agent({llm, tools: []});
    const output: string[] = [];
    const runner = createCliRunner(agent, (text) => { output.push(text); });
    // 人工暂停 agent_start，确定性地制造运行中状态，不依赖定时器。
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    agent.subscribe(async (event) => {
        if (event.type === "agent_start") await gate;
    });

    runner.startPrompt("开始");
    assert.equal(runner.isBusy, true);
    assert.equal(runner.handleControl({type: "new"}), true);
    assert.equal(runner.handleControl({type: "resume", sessionId: "other"}), true);
    assert.equal(runner.handleControl({type: "status"}), true);
    runner.startPrompt("重复");
    assert.equal(runner.handleControl({type: "abort"}), true);
    release();
    await runner.waitForIdle();

    assert.equal(agent.state.isRunning, false);
    assert.equal(runner.isBusy, false);
    assert.equal(llm.requests.length, 0);
    assert.match(output.join(""), /正在运行/);
    assert.match(output.join(""), /aborted/);
    assert.equal(runner.handleControl({type: "new"}), false);
    await runner.close();
});

test("CLI steer/followup 路由到双层 Loop，顺序不变", async () => {
    const llm = new FakeLlmClient([
        {role: "assistant", content: "原任务"},
        {role: "assistant", content: "新方向"},
        {role: "assistant", content: "总结"},
    ]);
    const agent = new Agent({llm, tools: []});
    const output: string[] = [];
    const runner = createCliRunner(agent, (text) => { output.push(text); });
    runner.handleControl({type: "steer", text: "空闲指令"});
    assert.match(output.join(""), /没有运行中的任务/);

    runner.startPrompt("开始");
    runner.handleControl({type: "followup", text: "最后总结"});
    runner.handleControl({type: "steer", text: "改为只读"});
    await runner.waitForIdle();
    assert.equal(llm.requests.length, 3);
    assert.equal(llm.requests[1]?.messages.at(-1)?.content, "改为只读");
    assert.equal(llm.requests[2]?.messages.at(-1)?.content, "最后总结");
    await runner.close();
});

test("模型失败能被报告，CLI 可以再次提交 Prompt", async () => {
    let fail = true;
    const agent = new Agent({
        llm: new FakeLlmClient([{role: "assistant", content: "恢复"}]),
        tools: [],
        transformContext: async (messages) => {
            if (fail) { fail = false; throw new Error("测试失败"); }
            return messages;
        },
    });
    const output: string[] = [];
    const runner = createCliRunner(agent, (text) => { output.push(text); });
    runner.startPrompt("第一次");
    await runner.waitForIdle();
    assert.match(output.join(""), /执行失败：测试失败/);
    runner.startPrompt("第二次");
    await runner.waitForIdle();
    assert.equal(agent.state.messages.at(-1)?.content, "恢复");
    await runner.close();
});

test("close 取消并等待运行收尾，关闭后不再接受 Prompt", async () => {
    const agent = new Agent({llm: new FakeLlmClient([]), tools: []});
    const output: string[] = [];
    const runner = createCliRunner(agent, (text) => { output.push(text); });
    runner.startPrompt("开始");
    await runner.close();
    assert.equal(runner.isBusy, false);
    runner.startPrompt("不能再开始");
    assert.match(output.join(""), /已关闭/);
});
