
import assert from "node:assert/strict";
import test from "node:test";
import {createAgentState} from "../src/agent-state.ts";
import type {AgentMessage, Tool} from "../src/types.ts";

test("创建 AgentState 时复制消息和工具数组", () => {
    const messages: AgentMessage[] = [
        {
            role: "user",
            content: "你好",
        },
    ];
    const tools: Tool[] = [];

    const state = createAgentState({
        systemPrompt: "你是一个编程助手",
        messages,
        tools,
    });

    // 修改构造参数的数组，不能影响已经创建的 AgentState。
    messages.push({
        role: "user",
        content: "后加入的消息",
    });

    assert.equal(state.systemPrompt, "你是一个编程助手");
    assert.equal(state.messages.length, 1);
    assert.equal(state.isRunning, false);
    assert.equal(state.streamingMessage, undefined);
    assert.equal(state.pendingToolCalls.size, 0);

    assert.notStrictEqual(state.messages, messages);
    assert.notStrictEqual(state.tools, tools);
});