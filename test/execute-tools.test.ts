import assert from "node:assert/strict";
import test from "node:test";
import {executeTools} from "../src/execute-tools.ts";
import {validateToolArguments} from "../src/tool-arguments.ts";
import type {AgentEvent} from "../src/agent-events.ts";
import type {AssistantMessage, Tool} from "../src/types.ts";
import Agent from "../src/agent.ts";
import {FakeLlmClient} from "../src/fake-llm.ts";
import {MemorySessionStore} from "../src/session/memory-session-store.ts";

const reply: AssistantMessage = {
    role: "assistant", content: "",
    toolCalls: [{id: "c1", name: "echo", arguments: {text: "hello"}}],
};

function createTool(execute?: Tool["execute"]): Tool {
    return {
        name: "echo", description: "测试",
        parameters: {
            type: "object",
            properties: {text: {type: "string"}},
            required: ["text"],
            additionalProperties: false,
        },
        execute: execute ?? (async () => ({content: "ok"})),
    };
}

test("校验根节点、必填字段、类型和未知字段", () => {
    const tool = createTool();
    assert.throws(() => validateToolArguments(tool, null), /必须是 object/);
    assert.throws(() => validateToolArguments(tool, {}), /缺少参数：text/);
    assert.throws(() => validateToolArguments(tool, {text: 1}), /必须是 string/);
    assert.throws(() => validateToolArguments(tool, {text: "a", x: 1}), /未知参数/);
    assert.deepEqual(validateToolArguments(tool, {text: "a"}), {text: "a"});
});

test("参数错误和 before 拒绝都不会执行工具；block+terminate 生效", async () => {
    let executed = 0;
    let after = 0;
    const tool = createTool(async () => { executed++; return {content: "ok"}; });
    const invalid = structuredClone(reply);
    invalid.toolCalls![0]!.arguments = {};
    const first = await executeTools([tool], invalid);
    assert.equal(first.results[0]?.isError, true);

    const second = await executeTools([tool], reply, {
        beforeToolCall: async () => ({block: true, reason: "禁止", terminate: true}),
        afterToolCall: async () => { after++; return undefined; },
    });
    assert.equal(executed, 0);
    assert.equal(after, 0);
    assert.equal(second.allTerminated, true);
    assert.match(second.results[0]?.content ?? "", /禁止/);
    assert.equal(Object.hasOwn(second.results[0]!, "terminate"), false);
});

test("顺序为 start、before、execute、update、after、end", async () => {
    const trace: string[] = [];
    const tool = createTool(async (_args, _signal, onUpdate) => {
        trace.push("execute");
        await onUpdate?.({content: "50%"});
        return {content: "原结果"};
    });
    const result = await executeTools([tool], reply, {
        emit: async (event) => { trace.push(event.type); },
        beforeToolCall: async () => { trace.push("before"); return undefined; },
        afterToolCall: async ({isError}) => {
            assert.equal(isError, false);
            trace.push("after");
            return {result: {content: "脱敏结果", terminate: true}};
        },
    });
    assert.deepEqual(trace, [
        "tool_execution_start", "before", "execute",
        "tool_execution_update", "after", "tool_execution_end",
    ]);
    assert.equal(result.results[0]?.content, "脱敏结果");
    assert.equal(result.allTerminated, true);
});

test("execute 失败仍调用 after；after 也可转换错误", async () => {
    const result = await executeTools([
        createTool(async () => { throw new Error("敏感错误"); }),
    ], reply, {
        afterToolCall: async ({isError}) => {
            assert.equal(isError, true);
            return {result: {content: "已处理"}, isError: false};
        },
    });
    assert.equal(result.results[0]?.isError, false);
    assert.equal(result.results[0]?.content, "已处理");
});

test("after 抛错生成错误结果；未知工具不进入 after", async () => {
    const result = await executeTools([createTool()], reply, {
        afterToolCall: async () => { throw new Error("后处理失败"); },
    });
    assert.equal(result.results[0]?.isError, true);
    assert.match(result.results[0]?.content ?? "", /后处理失败/);
    let after = 0;
    await executeTools([], reply, {
        afterToolCall: async () => { after++; return undefined; },
    });
    assert.equal(after, 0);
});

test("取消后不执行剩余工具，但每个 call 都有一个结果", async () => {
    const controller = new AbortController();
    let executions = 0;
    const events: AgentEvent[] = [];
    const batch = structuredClone(reply);
    batch.toolCalls!.push({id: "c2", name: "echo", arguments: {text: "second"}});
    const tool = createTool(async (_args, signal) => {
        executions++;
        controller.abort();
        signal?.throwIfAborted();
        return {content: "不可达"};
    });
    const result = await executeTools([tool], batch, {
        signal: controller.signal,
        emit: (event) => { events.push(event); },
    });
    assert.equal(executions, 1);
    assert.deepEqual(result.results.map((item) => item.toolCallId), ["c1", "c2"]);
    assert.ok(result.results.every((item) => item.isError));
    assert.equal(events.filter((event) => event.type === "tool_execution_end").length, 2);
});

test("进度订阅失败不被吞成普通工具错误", async () => {
    await assert.rejects(executeTools([
        createTool(async (_args, _signal, onUpdate) => {
            await onUpdate?.({content: "进度"});
            return {content: "ok"};
        }),
    ], reply, {
        emit: (event) => {
            if (event.type === "tool_execution_update") throw new Error("订阅失败");
        },
    }), /订阅失败/);
});

test("空批次和混合 terminate 批次不算全部终止", async () => {
    assert.equal((await executeTools([], {role: "assistant", content: ""})).allTerminated, false);
    let count = 0;
    const batch = structuredClone(reply);
    batch.toolCalls!.push({id: "c2", name: "echo", arguments: {text: "b"}});
    const result = await executeTools([createTool(async () => ({
        content: "ok", terminate: ++count === 1,
    }))], batch);
    assert.equal(result.allTerminated, false);
});

test("Agent 贯通 before terminate 和 after，不再自动请求第二次模型", async () => {
    for (const mode of ["before", "after"] as const) {
        const llm = new FakeLlmClient([reply]);
        const agent = new Agent({
            llm,
            tools: [createTool()],
            sessionStore: new MemorySessionStore({id: mode, createdAt: 0}),
            beforeToolCall: mode === "before"
                ? async () => ({block: true, terminate: true})
                : undefined,
            afterToolCall: mode === "after"
                ? async () => ({result: {content: "完成", terminate: true}})
                : undefined,
        });
        const result = await agent.prompt("开始");
        assert.equal(result.reason, "terminated");
        assert.equal(llm.requests.length, 1);
        assert.equal(agent.state.pendingToolCalls.size, 0);
    }
});