import assert from "node:assert/strict";
import test from "node:test";
import {parseCliCommand} from "../src/cli-command.ts";

test("解析运行控制与原命令", () => {
    assert.deepEqual(parseCliCommand("/compact"), {type: "compact"});
    assert.deepEqual(parseCliCommand("/status"), {type: "status"});
    assert.deepEqual(parseCliCommand("/abort"), {type: "abort"});
    assert.deepEqual(parseCliCommand("/steer 改成 只读"), {type: "steer", text: "改成 只读"});
    assert.deepEqual(parseCliCommand("/followup 总结"), {type: "followup", text: "总结"});
    assert.deepEqual(parseCliCommand("/steer"), {type: "steer", text: undefined});
    assert.deepEqual(parseCliCommand("/new"), {type: "new"});
    assert.deepEqual(parseCliCommand("/resume abc"), {type: "resume", sessionId: "abc"});
    assert.deepEqual(parseCliCommand("/sessions"), {type: "list"});
    assert.deepEqual(parseCliCommand("/skills"), {type: "skills"});
    assert.deepEqual(parseCliCommand("/skill:dev 检查代码"), {
        type: "skill", name: "dev", additionalInstructions: "检查代码",
    });
});

test("exit 文本和 /exit 命令不同；保留未知命令回退", () => {
    assert.deepEqual(parseCliCommand("exit"), {type: "prompt", text: "exit"});
    assert.deepEqual(parseCliCommand("/exit"), {type: "exit"});
    assert.deepEqual(parseCliCommand("/unknown"), {type: "prompt", text: "/unknown"});
    assert.deepEqual(parseCliCommand(" "), {type: "empty"});
});
