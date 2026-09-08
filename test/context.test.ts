
import assert from "node:assert/strict";
import test from "node:test";
import {prepareLlmContext} from "../src/context.ts";
import type {AgentMessage} from "../src/types.ts";

test("先 transformContext 再 convertToLlm", async () => {
    const calls: string[] = [];

    const result = await prepareLlmContext(
        [{role: "user", content: "raw"}],
        async (messages) => {
            calls.push("transform");
            return [
                ...messages,
                {role: "user", content: "injected"},
            ];
        },
        (messages) => {
            calls.push("convert");
            return messages;
        },
    );

    assert.deepEqual(calls, ["transform", "convert"]);
    assert.deepEqual(result.map((message) => message.content), [
        "raw",
        "injected",
    ]);
});

test("transformContext 修改数组时不影响原始上下文", async () => {
    const original: AgentMessage[] = [
        {role: "user", content: "original"},
    ];

    await prepareLlmContext(
        original,
        async (messages) => {
            messages.push({role: "user", content: "temporary"});
            return messages;
        },
        (messages) => messages,
    );

    assert.equal(original.length, 1);
});