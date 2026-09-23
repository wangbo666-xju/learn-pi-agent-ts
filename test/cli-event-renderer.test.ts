import assert from "node:assert/strict";
import test from "node:test";
import {createCliEventRenderer} from "../src/cli-event-renderer.ts";

test("只打印文本增量，message_end 不重复打印全文", async () => {
    const output: string[] = [];
    const render = createCliEventRenderer((text) => { output.push(text); });
    await render({
        type: "message_update",
        message: {role: "assistant", content: "你好"},
        update: {type: "text_delta", delta: "你好"},
    });
    await render({
        type: "message_update",
        message: {role: "assistant", content: "你好"},
        update: {type: "toolcall_delta"},
    });
    await render({type: "message_end", message: {role: "assistant", content: "你好"}});
    await render({
        type: "tool_execution_update", toolCallId: "c1", toolName: "echo",
        partialResult: {content: "50%"},
    });
    await render({
        type: "tool_execution_end", toolCallId: "c1", toolName: "echo",
        result: {content: "完成"}, isError: false,
    });
    assert.deepEqual(output, [
        "你好", "\n", "\n工具进度：echo 50%\n", "\n工具执行状态：echo:done\n",
    ]);
});
