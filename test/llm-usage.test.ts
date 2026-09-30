import assert from "node:assert/strict";
import test from "node:test";
import {RealLlmClient} from "../src/real-llm.ts";
import {normalizeUsage, createLlmHttpError, ContextOverflowError} from "../src/llm-usage.ts";

test("兼容接口只有明确的窗口超限文案才进入恢复，不误判鉴权或输出参数错误", () => {
    const body = JSON.stringify({error: {code: "invalid_request_error", message:
        "This model's maximum context length is 65536 tokens. However, you requested 66000 tokens."}});
    assert.ok(createLlmHttpError(400, body) instanceof ContextOverflowError);
    assert.equal(createLlmHttpError(401, body) instanceof ContextOverflowError, false);
    assert.equal(createLlmHttpError(400, JSON.stringify({error: {message: "max_tokens must be positive"}})) instanceof ContextOverflowError, false);
});

test("缺失和非法 usage 不作为基线；DeepSeek 缓存命中也不重复相加", () => {
    for (const value of [undefined, null, {}, {prompt_tokens: -1, completion_tokens: 1},
        {prompt_tokens: "100", completion_tokens: 1}, {prompt_tokens: 100, completion_tokens: NaN},
        {prompt_tokens: 100, completion_tokens: 1, prompt_cache_hit_tokens: 200}]) {
        assert.equal(normalizeUsage(value), undefined);
    }
    assert.deepEqual(normalizeUsage({prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 40}),
        {input: 60, output: 20, cacheRead: 40, cacheWrite: 0, totalTokens: 120});
});

test("解析非流式及独立 SSE usage 帧，缓存不重复计数，元数据不发回模型", async (t) => {
    for (const [name, value] of Object.entries({OPENAI_API_KEY: "test", OPENAI_BASE_URL: "https://example.test", OPENAI_MODEL: "test"})) {
        const previous = process.env[name];
        process.env[name] = value;
        t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
    }
    const bodies: Record<string, unknown>[] = [];
    t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        bodies.push(body);
        const usage = {prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
            prompt_tokens_details: {cached_tokens: 30}};
        return body.stream ? new Response([
            'data: {"choices":[{"delta":{"content":"ok"}}]}',
            `data: ${JSON.stringify({choices: [], usage})}`,
            "data: [DONE]", "",
        ].join("\n\n")) : new Response(JSON.stringify({choices: [{message: {content: "ok"}}], usage}));
    });
    const llm = new RealLlmClient();
    const reply = await llm.chat([], []);
    assert.deepEqual(reply.usage, {input: 70, output: 20, cacheRead: 30, cacheWrite: 0, totalTokens: 120});
    let doneUsage: unknown;
    const streamed = await llm.chatStream([reply], [], (event) => {
        if (event.type === "done") doneUsage = event.message.usage;
    });
    assert.deepEqual(streamed.usage, reply.usage);
    assert.deepEqual(doneUsage, reply.usage);
    assert.deepEqual(bodies[1]!.stream_options, {include_usage: true});
    assert.deepEqual(bodies[1]!.messages, [{role: "assistant", content: "ok"}]);
    assert.equal(typeof streamed.usageContextKey, "string");
});

test("只有明确的上下文溢出被分类；普通 400 不触发恢复", async (t) => {
    const saved = {...process.env};
    Object.assign(process.env, {OPENAI_API_KEY: "test", OPENAI_BASE_URL: "https://example.test", OPENAI_MODEL: "test"});
    t.after(() => { for (const key of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"]) {
        if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }});
    let code = "context_length_exceeded";
    t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({error: {code, message: "bad request"}}), {status: 400}));
    const llm = new RealLlmClient();
    await assert.rejects(llm.chatStream([], [], () => {}), {name: "ContextOverflowError"});
    code = "invalid_request_error";
    await assert.rejects(llm.chat([], []), (error: Error) => error.name !== "ContextOverflowError");
});
