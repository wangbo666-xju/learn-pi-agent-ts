import assert from "node:assert/strict";
import test from "node:test";
import {runAgentLoop, type AgentContext} from "../src/agent-loop.ts";
import type {AgentEvent} from "../src/agent-events.ts";
import {FakeLlmClient} from "../src/fake-llm.ts";
import type {Tool, ToolArguments, ToolExecutionResult} from "../src/types.ts";

test("直接回答时按顺序发布完整消息生命周期", async () => {
    const events: AgentEvent[] = [];
    const context: AgentContext = {
        systemPrompt: "",
        messages: [],
        tools: [],
    };

    const result = await runAgentLoop(
        [{role: "user", content: "hello"}],
        context,
        {
            llm: new FakeLlmClient([
                {role: "assistant", content: "world"},
            ]),
            maxTurns: 10,
            emit: (event) => {
                events.push(structuredClone(event));
            },
        },
    );

    assert.equal(result.reason, "completed");
    assert.deepEqual(events.map((event) => event.type), [
        "agent_start",
        "message_start",
        "message_end",
        "turn_start",
        "message_start",
        "message_update",
        "message_end",
        "turn_end",
        "agent_end",
    ]);
    assert.deepEqual(context.messages, [
        {role: "user", content: "hello"},
        {role: "assistant", content: "world"},
    ]);
});

class ThrowingTool implements Tool {
    readonly name = "broken";
    readonly description = "总是抛出异常的测试工具";
    readonly parameters = {
        type: "object",
        properties: {},
        additionalProperties: false,
    };

    async execute(_args: ToolArguments): Promise<ToolExecutionResult> {
        throw new Error("boom");
    }
}

test("工具执行失败仍发布结束事件并把错误回传模型", async () => {
    const events: AgentEvent[] = [];
    const context: AgentContext = {
        systemPrompt: "",
        messages: [],
        tools: [new ThrowingTool()],
    };

    const result = await runAgentLoop(
        [{role: "user", content: "调用失败工具"}],
        context,
        {
            llm: new FakeLlmClient([
                {
                    role: "assistant",
                    content: "",
                    toolCalls: [{id: "call-1", name: "broken", arguments: {}}],
                },
                {role: "assistant", content: "已经收到工具错误"},
            ]),
            maxTurns: 10,
            emit: (event) => {
                events.push(structuredClone(event));
            },
        },
    );

    assert.equal(result.reason, "completed");
    assert.deepEqual(
        events.filter((event) => event.type === "tool_execution_start" || event.type === "tool_execution_end")
            .map((event) => event.type),
        ["tool_execution_start", "tool_execution_end"],
    );

    const toolEnd = events.find((event) => event.type === "tool_execution_end");
    assert.deepEqual(toolEnd, {
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "broken",
        result: {content: "工具执行失败: boom"},
        isError: true,
    });
    assert.deepEqual(context.messages[2], {
        role: "toolResult",
        toolCallId: "call-1",
        content: "工具执行失败: boom",
        isError: true,
        details: undefined,
    });
});
