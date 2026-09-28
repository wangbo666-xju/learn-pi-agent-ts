import assert from "node:assert/strict";
import test from "node:test";
import { RealLlmClient } from "../src/real-llm.ts";
import type {LlmStreamEvent} from "../src/types.ts";

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
test("chatStream 按顺序发出模型语义事件", async () => {
	const originalFetch = globalThis.fetch;
	const originalApiKey = process.env.OPENAI_API_KEY;
	const originalBaseUrl = process.env.OPENAI_BASE_URL;
	const originalModel = process.env.OPENAI_MODEL;

	process.env.OPENAI_API_KEY = "test-key";
	process.env.OPENAI_BASE_URL = "https://example.test";
	process.env.OPENAI_MODEL = "test-model";

	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(
				'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
			));
			controller.enqueue(encoder.encode(
				'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
			));
			controller.enqueue(encoder.encode("data: [DONE]\n\n"));
			controller.close();
		},
	});

	globalThis.fetch = async (_input, init) => {
		const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
		assert.equal("tools" in request, false);
		assert.equal("tool_choice" in request, false);
		return new Response(body, {status: 200});
	};

	try {
		const events: LlmStreamEvent[] = [];
		const client = new RealLlmClient();
		const result = await client.chatStream(
			[{role: "user", content: "hi"}],
			[],
			(event) => {
				events.push(structuredClone(event));
			},
		);

		assert.deepEqual(
			events.map((event) => event.type),
			["start", "text_delta", "text_delta", "done"],
		);
		assert.equal(events[1]?.type === "text_delta" && events[1].partial.content, "Hel");
		assert.equal(events[2]?.type === "text_delta" && events[2].partial.content, "Hello");
		assert.equal(result.content, "Hello");
	} finally {
		globalThis.fetch = originalFetch;
		process.env.OPENAI_API_KEY = originalApiKey;
		process.env.OPENAI_BASE_URL = originalBaseUrl;
		process.env.OPENAI_MODEL = originalModel;
	}
});

test("摘要请求省略工具、限制输出并拒绝截断响应", async () => {
    const previousFetch = globalThis.fetch;
    const names = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"];
    const saved = names.map((name) => process.env[name]);
    process.env.OPENAI_API_KEY = "test-only";
    process.env.OPENAI_BASE_URL = "https://example.test";
    process.env.OPENAI_MODEL = "test-model";
    let finishReason = "stop";
    globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        assert.equal(body.max_tokens, 2048);
        assert.equal("tools" in body, false);
        assert.equal("tool_choice" in body, false);
        return new Response(JSON.stringify({choices: [{
            finish_reason: finishReason,
            message: {content: "摘要"},
        }]}));
    };
    try {
        const client = new RealLlmClient();
        const reply = await client.chat([], [], {maxOutputTokens: 2048});
        assert.equal(reply.content, "摘要");
        finishReason = "length";
        await assert.rejects(client.chat([], [], {maxOutputTokens: 2048}), /长度上限/);
    } finally {
        globalThis.fetch = previousFetch;
        names.forEach((name, index) => {
            const value = saved[index];
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        });
    }
});
