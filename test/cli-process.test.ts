import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {cp, mkdtemp, rm} from "node:fs/promises";
import {createServer} from "node:http";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";

for (const exitMode of ["command", "eof", "signal"] as const) {
    test("真实 CLI 在模型流中响应控制并清理退出：" + exitMode, {timeout: 15000}, async (t) => {
        // 隔离源码和 Session；只连接本地 SSE 服务，不读取真实凭据或修改用户历史。
        const root = await mkdtemp(join(tmpdir(), "agent-cli-test-"));
        await cp(fileURLToPath(new URL("../src", import.meta.url)), join(root, "src"), {recursive: true});
        await cp(fileURLToPath(new URL("../package.json", import.meta.url)), join(root, "package.json"));
        let notifyDisconnected: () => void = () => {};
        const disconnected = new Promise<void>((resolve) => { notifyDisconnected = resolve; });
        const server = createServer((req, res) => {
            req.resume();
            res.writeHead(200, {"Content-Type": "text/event-stream"});
            res.write('data: {"choices":[{"delta":{"content":"测试流已开始"}}]}\n\n');
            res.on("close", notifyDisconnected);
            // 不发送 DONE，让客户端在读取网络流期间处理下一条命令。
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const child = spawn(process.execPath, [
            "--import", new URL("./helpers/cli-signal.mjs", import.meta.url).href,
            join(root, "src/main.ts"),
        ], {
            cwd: root,
            env: {...process.env, OPENAI_API_KEY: "test-only", OPENAI_MODEL: "test",
                OPENAI_BASE_URL: `http://127.0.0.1:${address.port}`},
            stdio: ["pipe", "pipe", "pipe", "ipc"],
        });
        const exited = once(child, "exit");
        const {stdin, stdout, stderr} = child;
        assert.ok(stdin && stdout && stderr);
        t.after(async () => {
            if (child.exitCode === null && child.signalCode === null) child.kill();
            await exited;
            server.closeAllConnections();
            await new Promise<void>((resolve) => { server.close(() => resolve()); });
            await rm(root, {recursive: true, force: true});
        });
        let output = "";
        let errors = "";
        stdout.setEncoding("utf8");
        stderr.setEncoding("utf8");
        stdout.on("data", (text: string) => { output += text; });
        stderr.on("data", (text: string) => { errors += text; });
        async function waitForOutput(text: string): Promise<void> {
            while (!output.includes(text)) {
                assert.equal(child.exitCode, null, errors);
                await once(stdout!, "data", {signal: t.signal});
            }
        }
        await waitForOutput("/exit");
        stdin.write("开始\n");
        await waitForOutput("测试流已开始");
        stdin.write("/status\n/new\n");
        await waitForOutput('"isRunning":true');
        await waitForOutput("当前任务尚未收尾");
        if (exitMode === "command") stdin.write("/exit\n");
        else if (exitMode === "eof") stdin.end();
        else child.send("SIGINT");
        await waitForOutput("本次运行结束：aborted");
        const [code] = await exited;
        assert.equal(code, 0, errors);
        await disconnected;
        assert.equal(errors, "");
    });
}
