import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "../src/session/session-manager.ts";

test("创建 Session 后可以在列表中找到它", async (t) => {
	const sessionsDir = await mkdtemp(join(tmpdir(), "agent-ts-sessions-"));

	t.after(async () => {
		await rm(sessionsDir, { recursive: true, force: true });
	});

	const manager = new SessionManager(sessionsDir);
	const store = await manager.create();
	const { id } = await store.getMetadata();

	assert.deepEqual(await manager.listSessionIds(), [id]);
});

test("拒绝包含路径分隔符的 sessionId", async (t) => {
	const sessionsDir = await mkdtemp(join(tmpdir(), "agent-ts-sessions-"));

	t.after(async () => {
		await rm(sessionsDir, { recursive: true, force: true });
	});

	const manager = new SessionManager(sessionsDir);

	await assert.rejects(
		manager.open("../outside"),
		/非法 sessionId/,
	);
});
