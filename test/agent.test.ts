import assert from "node:assert/strict";
import test from "node:test";
import Agent from "../src/agent.ts";
import {FakeLlmClient} from "../src/fake-llm.ts";
import type {BeforeToolCall, Tool, ToolArguments, ToolExecutionResult} from "../src/types.ts";
import {MemorySessionStore} from "../src/session/memory-session-store.ts";
import {randomUUID} from "node:crypto";

const allowAll: BeforeToolCall = async () => undefined;

class TestTool implements Tool {
    readonly name = "echo";
    readonly description = "返回传入的文本";
    readonly parameters = {
        type: "object",
        properties: {
            text: {type: "string"},
        },
        required: ["text"],
        additionalProperties: false,
    };
    readonly inputs: ToolArguments[] = [];
    private readonly errorMessage?: string;

    constructor(errorMessage?: string) {
        this.errorMessage = errorMessage;
    }

    async execute(args: ToolArguments): Promise<ToolExecutionResult> {
        this.inputs.push(args);
        if (this.errorMessage) {
            throw new Error(this.errorMessage);
        }
        if (typeof args.text !== "string") {
            throw new Error("echo 工具缺少 text 参数");
        }
        return {
            content: `echo:${args.text}`,
        };
    }
}

test("模型直接回答时结束循环并返回本轮消息", async () => {
    const llm = new FakeLlmClient([
        {role: "assistant", content: "直接回答"},
    ]);
    const sessionStore = new MemorySessionStore({
        id: "session-1",
        createdAt: 1000,
    });
    const agent = new Agent(llm, [], allowAll, sessionStore);

    const messages = await agent.prompt("你好");

    assert.deepEqual(messages, [
        {role: "user", content: "你好"},
        {role: "assistant", content: "直接回答"},
    ]);
    assert.equal(llm.requests.length, 1);
    assert.deepEqual(llm.requests[0]?.messages, [
        {role: "user", content: "你好"},
    ]);
});

test("模型调用工具后把工具结果加入上下文并继续请求模型", async () => {
    const llm = new FakeLlmClient([
        {
            role: "assistant",
            content: "",
            toolCalls: [
                {id: "call-1", name: "echo", arguments: {text: "hello"}},
            ],
        },
        {role: "assistant", content: "工具执行完成"},
    ]);
    const tool = new TestTool();
    const sessionStore = new MemorySessionStore({
        id: "session-1",
        createdAt: 1000,
    });
    const agent = new Agent(llm, [tool], allowAll, sessionStore);

    const messages = await agent.prompt("调用 echo");

    assert.deepEqual(messages.map((message) => message.role), [
        "user",
        "assistant",
        "toolResult",
        "assistant",
    ]);
    assert.deepEqual(messages[2], {
        role: "toolResult",
        toolCallId: "call-1",
        content: "echo:hello",
        isError: false,
        details: undefined,
    });
    assert.deepEqual(llm.requests[1]?.messages, messages.slice(0, 3));
});

test("工具抛出异常时把错误作为 toolResult 回传给模型", async () => {
    const llm = new FakeLlmClient([
        {
            role: "assistant",
            content: "",
            toolCalls: [
                {id: "call-error", name: "echo", arguments: {text: "hello"}},
            ],
        },
        {role: "assistant", content: "已收到工具错误"},
    ]);

    const sessionStore = new MemorySessionStore({
        id: "session-1",
        createdAt: 1000,
    });


    const agent = new Agent(llm, [new TestTool("boom")], allowAll, sessionStore);

    const messages = await agent.prompt("执行一个失败工具");

    assert.deepEqual(messages[2], {
        role: "toolResult",
        toolCallId: "call-error",
        content: "工具执行失败: boom",
        isError: true,
        details: undefined,
    });
    assert.equal(messages.at(-1)?.role, "assistant");
});

test("beforeToolCall 拦截时不执行工具并把拒绝原因回传给模型", async () => {
    const llm = new FakeLlmClient([
        {
            role: "assistant",
            content: "",
            toolCalls: [
                {id: "call-blocked", name: "echo", arguments: {text: "hello"}},
            ],
        },
        {role: "assistant", content: "已停止调用"},
    ]);
    const tool = new TestTool();
    const blockAll: BeforeToolCall = async () => ({
        block: true,
        reason: "测试策略拒绝执行",
    });
    const sessionStore = new MemorySessionStore({
        id: "session-1",
        createdAt: 1000,
    });
    const agent = new Agent(llm, [tool], blockAll, sessionStore);

    const messages = await agent.prompt("调用被禁止的工具");

    assert.equal(tool.inputs.length, 0);
    assert.deepEqual(messages[2], {
        role: "toolResult",
        toolCallId: "call-blocked",
        content: "工具调用被拒绝：测试策略拒绝执行",
        isError: true,
        details: undefined,
    });
});

test("连续调用 prompt 时会携带 Session 中的历史消息", async () => {
    const llm = new FakeLlmClient([
        {
            role: "assistant",
            content: "第一次回答",
        },
        {
            role: "assistant",
            content: "第二次回答",
        },
    ]);

    const sessionStore = new MemorySessionStore({
        id: "session-1",
        createdAt: 1000,
    });

    const agent = new Agent(
        llm,
        [],
        allowAll,
        sessionStore,
    );

    await agent.prompt("第一次提问");
    await agent.prompt("第二次提问");

    assert.deepEqual(llm.requests[1]?.messages, [
        {
            role: "user",
            content: "第一次提问",
        },
        {
            role: "assistant",
            content: "第一次回答",
        },
        {
            role: "user",
            content: "第二次提问",
        },
    ]);

    assert.deepEqual(await sessionStore.getMessages(), [
        {
            role: "user",
            content: "第一次提问",
        },
        {
            role: "assistant",
            content: "第一次回答",
        },
        {
            role: "user",
            content: "第二次提问",
        },
        {
            role: "assistant",
            content: "第二次回答",
        },
    ]);
});
