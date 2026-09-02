import assert from "node:assert/strict";
import test from "node:test";
import { RealLlmClient } from "../src/real-llm.ts";

test("非流式 chat 也会发送 systemPrompt", async () => {
	const originalFetch = globalThis.fetch;
	const originalApiKey = process.env.OPENAI_API_KEY;
	const originalBaseUrl = process.env.OPENAI_BASE_URL;
	const originalModel = process.env.OPENAI_MODEL;
	let requestBody: unknown;

	process.env.OPENAI_API_KEY = "test-key";
	process.env.OPENAI_BASE_URL = "https://example.test";
	process.env.OPENAI_MODEL = "test-model";

	globalThis.fetch = async (_input, init) => {
		requestBody = JSON.parse(String(init?.body));
		return new Response(
			JSON.stringify({
				choices: [{ message: { content: "ok" } }],
			}),
		);
	};

	try {
		const client = new RealLlmClient();
		await client.chat(
			[{ role: "user", content: "你好" }],
			[],
			{ systemPrompt: "Skill 索引" },
		);

		assert.deepEqual((requestBody as { messages: unknown[] }).messages[0], {
			role: "system",
			content: "Skill 索引",
		});
	} finally {
		globalThis.fetch = originalFetch;
		process.env.OPENAI_API_KEY = originalApiKey;
		process.env.OPENAI_BASE_URL = originalBaseUrl;
		process.env.OPENAI_MODEL = originalModel;
	}
});
