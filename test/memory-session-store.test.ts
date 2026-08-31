import assert from "node:assert/strict";
import test from "node:test";
import { MemorySessionStore } from "../src/session/memory-session-store.ts";
import type { AgentMessage } from "../src/types.ts";
import {FakeLlmClient} from "../src/fake-llm.ts";
import {Agent} from "node:http";


test("按追加顺序保存消息并生成递增序号", async () => {

    const store = new MemorySessionStore({
        id: "session-1",
        createdAt: 1000,
    });

    const userMessage: AgentMessage = {
        role: "user",
        content: "读取 README.md",
    };

    const assistantMessage: AgentMessage = {
        role: "assistant",
        content: "正在读取",
    };

    const firstEntry = await store.appendMessage(userMessage);
    const secondEntry = await store.appendMessage(assistantMessage);

    assert.equal(firstEntry.seq, 1);
    assert.equal(secondEntry.seq, 2);
    assert.deepEqual(await store.getMessages(), [
        userMessage,
        assistantMessage,
    ]);

});
