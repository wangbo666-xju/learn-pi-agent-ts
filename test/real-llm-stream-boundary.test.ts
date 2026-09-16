import assert from "node:assert/strict";
import test from "node:test";
import {RealLlmClient} from "../src/real-llm.ts";
import type {LlmStreamEvent} from "../src/types.ts";

// 同一条合法文本帧，分别模拟有完成标志和没有完成标志的响应。
// 两种情况都能解析到文本，避免把 JSON 格式错误误当成截断检测。
for (const complete of [true, false]) {
    test(
        complete
            ? "SSE 收到 DONE 后可以正常发布完整消息"
            : "SSE 未收到任何完成标志就 EOF，应拒绝且不发布 done",
        async (t) => {
            const keys = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"] as const;
            const originalValues = keys.map((key) => [key, process.env[key]] as const);
            const originalFetch = globalThis.fetch;
            t.after(() => {
                globalThis.fetch = originalFetch;
                for (const [key, value] of originalValues) {
                    if (value === undefined) delete process.env[key];
                    else process.env[key] = value;
                }
            });

            process.env.OPENAI_API_KEY = "test-key";
            process.env.OPENAI_BASE_URL = "https://example.test";
            process.env.OPENAI_MODEL = "test-model";

            const frame = 'data: {"choices":[{"delta":{"content":"半段回答"}}]}\n\n';
            // 本地 Response 自动 EOF；完全替换 fetch，不发真实网络请求。
            globalThis.fetch = async () => new Response(
                frame + (complete ? "data: [DONE]\n\n" : ""),
                {headers: {"Content-Type": "text/event-stream"}},
            );

            const events: LlmStreamEvent[] = [];
            const run = new RealLlmClient().chatStream(
                [{role: "user", content: "开始"}],
                [],
                (event) => { events.push(structuredClone(event)); },
            );

            if (complete) {
                const reply = await run;
                assert.equal(reply.content, "半段回答");
                assert.deepEqual(events.map((event) => event.type), [
                    "start", "text_delta", "done",
                ]);
            } else {
                // 不约束具体错误文案，允许实现自行定义“不完整流”的错误类型。
                await assert.rejects(run);
                assert.deepEqual(events.map((event) => event.type), [
                    "start", "text_delta",
                ]);
            }
        },
    );
}
