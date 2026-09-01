import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionStore } from "../src/session/jsonl-session-store.ts";

test("重新打开 JSONL 后可以恢复消息并继续追加", async (t) => {
    const tempDirectory = await mkdtemp(
        join(tmpdir(), "agent-ts-session-"),
    );

    t.after(async () => {
        await rm(tempDirectory, {
            recursive: true,
            force: true,
        });
    });

    const sessionPath = join(tempDirectory, "session.jsonl");

    const firstStore = await JsonlSessionStore.create(
        sessionPath,
        {
            id: "session-1",
            createdAt: 1000,
        },
    );

    await firstStore.appendMessage({
        role: "user",
        content: "第一次提问",
    });

    await firstStore.appendMessage({
        role: "assistant",
        content: "第一次回答",
    });

    // 模拟程序退出后重新打开 Session。
    const reopenedStore = await JsonlSessionStore.open(sessionPath);

    assert.deepEqual(await reopenedStore.getMessages(), [
        {
            role: "user",
            content: "第一次提问",
        },
        {
            role: "assistant",
            content: "第一次回答",
        },
    ]);

    const thirdEntry = await reopenedStore.appendMessage({
        role: "user",
        content: "第二次提问",
    });

    assert.equal(thirdEntry.seq, 3);
});