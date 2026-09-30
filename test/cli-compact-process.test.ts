import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {cp, mkdtemp, rm} from "node:fs/promises";
import {createServer} from "node:http";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import test, {type TestContext} from "node:test";
import {JsonlSessionStore} from "../src/session/jsonl-session-store.ts";

/** 运行真实 main.ts，但文件与网络均隔离；不连接真实模型。 */
async function startCli(t: TestContext, holdSummary: boolean, automatic = false) {
    const root = await mkdtemp(join(tmpdir(), "agent-compact-cli-"));
    t.after(() => rm(root, {recursive: true, force: true}));
    await cp(fileURLToPath(new URL("../src", import.meta.url)), join(root, "src"), {recursive: true});
    await cp(fileURLToPath(new URL("../package.json", import.meta.url)), join(root, "package.json"));
    const file = join(root, "sessions/history.jsonl");
    const store = await JsonlSessionStore.create(file, {id: "history", createdAt: 0});
    for (let i = 1; i <= 3; i++) {
        await store.appendMessage({role: "user", content: "问题" + i});
        await store.appendMessage({role: "assistant", content: "回答" + i});
    }

    const requests: Record<string, unknown>[] = [];
    let notifySummary: () => void = () => {};
    let notifyDisconnected: () => void = () => {};
    const summaryStarted = new Promise<void>((resolve) => { notifySummary = resolve; });
    const disconnected = new Promise<void>((resolve) => { notifyDisconnected = resolve; });
    const server = createServer((req, res) => {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (text: string) => { body += text; });
        req.on("end", () => {
            const request = JSON.parse(body) as Record<string, unknown>;
            requests.push(request);
            if (request.stream) {
                res.writeHead(200, {"Content-Type": "text/event-stream"});
                res.end('data: {"choices":[{"delta":{"content":"恢复后继续完成"}}]}\n\n'
                    + (automatic ? `data: ${JSON.stringify({choices: [], usage: {
                        prompt_tokens: requests.length === 1 ? 850 : 100, completion_tokens: 50,
                    }})}\n\n` : "")
                    + "data: [DONE]\n\n");
            } else {
                res.on("close", notifyDisconnected);
                res.writeHead(200, {"Content-Type": "application/json"});
                res.flushHeaders();
                notifySummary();
                if (!holdSummary) res.end(JSON.stringify({
                    choices: [{finish_reason: "stop", message: {content: "S1：第一组已完成"}}],
                }));
            }
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => { server.close(() => resolve()); });
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const child = spawn(process.execPath, [
        "--import", new URL("./helpers/cli-signal.mjs", import.meta.url).href,
        join(root, "src/main.ts"),
    ], {
        cwd: root,
        env: {...process.env, OPENAI_API_KEY: "test-only", OPENAI_MODEL: "test",
            AGENT_CONTEXT_WINDOW: "1000", AGENT_COMPACT_RESERVE: "200",
            OPENAI_BASE_URL: `http://127.0.0.1:${address.port}`},
        stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    const exited = once(child, "exit");
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await exited;
    });
    const {stdin, stdout, stderr} = child;
    assert.ok(stdin && stdout && stderr);
    let output = "";
    let errors = "";
    stdout.setEncoding("utf8");
    stderr.setEncoding("utf8");
    stdout.on("data", (text: string) => { output += text; });
    stderr.on("data", (text: string) => { errors += text; });
    async function waitForOutput(text: string, count = 1): Promise<void> {
        while (output.split(text).length - 1 < count) {
            assert.equal(child.exitCode, null, errors);
            await once(stdout!, "data", {signal: t.signal});
        }
    }
    await waitForOutput("/compact");
    stdin.write("/resume history\n");
    await waitForOutput("已恢复会话：history");
    return {child, stdin, exited, waitForOutput, requests, file, summaryStarted, disconnected,
        errors: () => errors};
}

test("真实 CLI 自动压缩完成并落盘 usage，后续 /resume 恢复摘要", {timeout: 15000}, async (t) => {
    const cli = await startCli(t, false, true);
    cli.stdin.write("问题4\n");
    await cli.waitForOutput("自动压缩完成");
    cli.stdin.write("/resume history\n");
    await cli.waitForOutput("已恢复会话：history", 2);
    cli.stdin.write("问题5\n");
    await cli.waitForOutput("恢复后继续完成", 2);
    cli.stdin.write("/exit\n");
    assert.equal((await cli.exited)[0], 0, cli.errors());
    assert.equal(cli.requests.length, 3);
    assert.equal(cli.requests[0]!.stream, true);
    assert.equal(cli.requests[1]!.stream, undefined);
    const store = await JsonlSessionStore.open(cli.file);
    const entries = await store.getEntries();
    assert.equal(entries.filter((e) => e.type === "compaction").length, 1);
    const messages = await store.getMessages();
    assert.ok(messages.some((message) => message.role === "assistant" && message.usage?.totalTokens === 900));
    const requestMessages = cli.requests[2]!.messages as {role: string; content: string}[];
    assert.match(requestMessages[1]!.content, /S1：第一组已完成/);
    assert.equal(requestMessages.some((m) => m.content === "问题1"), false);
    assert.equal(requestMessages.at(-1)!.content, "问题5");
});

test("真实 CLI 自动压缩中的退出会取消摘要，不损失已经完成的回答", {timeout: 15000}, async (t) => {
    const cli = await startCli(t, true, true);
    cli.stdin.write("问题4\n");
    await cli.summaryStarted;
    cli.stdin.write("/status\n/new\n");
    await cli.waitForOutput('"isCompacting":true');
    await cli.waitForOutput("当前任务尚未收尾");
    cli.stdin.write("/exit\n");
    assert.equal((await cli.exited)[0], 0, cli.errors());
    await cli.disconnected;
    const entries = await (await JsonlSessionStore.open(cli.file)).getEntries();
    assert.equal(entries.length, 8);
    assert.equal(entries.at(-1)!.type, "message");
});

test("真实 CLI 压缩落盘，恢复后普通请求使用摘要且仍有工具", {timeout: 15000}, async (t) => {
    const cli = await startCli(t, false);
    cli.stdin.write("/compact\n");
    await cli.waitForOutput("压缩完成：5");
    assert.equal(cli.requests.length, 1);
    const request = cli.requests[0]!;
    assert.equal(request.max_tokens, 2048);
    assert.equal("tools" in request, false);
    assert.equal("tool_choice" in request, false);
    // 必须从 JSONL 重开，而不只是验证当前 Agent 内存被替换。
    cli.stdin.write("/resume history\n下一步\n");
    await cli.waitForOutput("恢复后继续完成");
    cli.stdin.write("/exit\n");
    assert.equal((await cli.exited)[0], 0, cli.errors());
    assert.equal(cli.errors(), "");
    assert.equal(cli.requests.length, 2);
    const messages = cli.requests[1]!.messages as {role: string; content: string}[];
    assert.match(messages[1]!.content, /S1：第一组已完成/);
    assert.equal(messages[2]!.content, "问题2");
    assert.equal(messages.at(-1)!.content, "下一步");
    assert.equal(messages.some((message) => message.content === "问题1"), false);
    assert.equal((cli.requests[1]!.tools as unknown[]).length, 3);
    const reopened = await JsonlSessionStore.open(cli.file);
    assert.equal((await reopened.getMessages()).length, 8);
    assert.equal((await reopened.getEntries()).filter((entry) => entry.type === "compaction").length, 1);
});

for (const mode of ["abort", "command", "eof", "signal"] as const) {
    test("真实 CLI 压缩请求可取消且不保存摘要：" + mode, {timeout: 15000}, async (t) => {
        const cli = await startCli(t, true);
        cli.stdin.write("/compact\n");
        await cli.summaryStarted;
        cli.stdin.write("/status\n/new\n");
        await cli.waitForOutput('"isCompacting":true');
        await cli.waitForOutput("当前任务尚未收尾");
        if (mode === "abort") {
            cli.stdin.write("/abort\n");
            await cli.waitForOutput("压缩已取消");
            cli.stdin.write("/status\n");
            await cli.waitForOutput('"isCompacting":false');
            cli.stdin.write("/exit\n");
        } else if (mode === "command") cli.stdin.write("/exit\n");
        else if (mode === "eof") cli.stdin.end();
        else cli.child.send("SIGINT");
        await cli.waitForOutput("压缩已取消");
        assert.equal((await cli.exited)[0], 0, cli.errors());
        await cli.disconnected;
        assert.equal(cli.errors(), "");
        assert.equal(cli.requests.length, 1);
        const reopened = await JsonlSessionStore.open(cli.file);
        assert.equal((await reopened.getEntries()).length, 6);
    });
}
