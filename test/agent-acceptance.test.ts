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
