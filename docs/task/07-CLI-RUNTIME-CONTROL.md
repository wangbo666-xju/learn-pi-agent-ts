# Task 7：CLI 运行控制执行文档

## 改动总结、效果与原因

| 改动 | 完成后的效果 | 为什么需要 |
|---|---|---|
| Prompt 后台运行 | 模型输出时还能输入 /abort、/status | 旧 CLI await prompt 后才读下一行，控制命令根本进不来 |
| 独立 CLI Runner | 集中处理并发入口、错误和运行控制 | main 只负责装配与命令路由 |
| 独立事件渲染器 | 流式文本与工具状态有唯一显示入口 | 不再在 main、Loop、LLM 多处打印 |
| 运行中拒绝 /new、/resume | 旧任务不会在切换会话时继续写入 | 会话替换必须等旧 Run 真正完成 |
| 退出时 abort + 等待清理 | /exit、Ctrl+C、输入结束都收尾 | 不能只关闭 readline 留下网络请求 |

例子：输入“分析项目”后，Prompt 不再堵住输入循环；马上输入 /steer 只读文件，消息排队到当前 Turn 之后处理。/abort 则触发当前 signal。

**前置条件：** Task 6 完成，使用 createSessionAgent 装配存储。
**输入：** Agent 的 prompt/abort/steer/followUp/waitForIdle/state。
**输出：** createCliRunner、createCliEventRenderer、扩展的 CliCommand。
**技术：** Node readline 异步迭代、Promise、现有 AgentEvent。
**设计依据：** [学习版设计](../PI_AGENT_LEARNING_DESIGN.md)、[Task 6](./06-SESSION-EVENT-PERSISTENCE.md)。

> 本文是手工实施文档。若交由 Agent 自动实施，应使用 executing-plans 分步实施。本任务不改 Loop，也不在 CLI 执行工具。

## 1. 文件清单与实施顺序

| 文件 | 操作 |
|---|---|
| src/cli-command.ts | 整体替换，保留原命令和未知命令回退 |
| src/cli-event-renderer.ts | 新建完整文件 |
| src/cli-agent-runner.ts | 保留 runAgentPrompt，新增 createCliRunner |
| src/main.ts | 整体替换 |
| test/cli-command.test.ts | 新建完整测试 |
| test/cli-event-renderer.test.ts | 新建完整测试 |
| test/cli-runtime.test.ts | 新建完整测试 |
| test/cli-agent-runner.test.ts | 原来的错误处理测试保留 |
| package.json | 追加三个测试文件 |

- [ ] 先创建第 6 节测试，运行并观察缺少新方法/新命令。
- [ ] 实施第 2～5 节。
- [ ] 运行第 7 节自动化与手动验收。

## 2. src/cli-command.ts：整体替换

~~~ts
export type CliCommand =
    | {type: "empty"}
    | {type: "new"}
    | {type: "list"}
    | {type: "skills"}
    | {type: "skill"; name: string; additionalInstructions?: string}
    | {type: "resume"; sessionId?: string}
    | {type: "help"}
    | {type: "exit"}
    | {type: "status"}
    | {type: "abort"}
    | {type: "steer"; text?: string}
    | {type: "followup"; text?: string}
    | {type: "prompt"; text: string};

export function parseCliCommand(input: string): CliCommand {
    const text = input.trim();
    if (!text) return {type: "empty"};
    if (!text.startsWith("/")) return {type: "prompt", text};

    const [command = "", ...args] = text.split(/\s+/);
    if (command.startsWith("/skill:")) {
        return {
            type: "skill",
            name: command.slice("/skill:".length),
            additionalInstructions: args.join(" ") || undefined,
        };
    }

    switch (command) {
        case "/new": return {type: "new"};
        case "/sessions": return {type: "list"};
        case "/resume": return {type: "resume", sessionId: args[0]};
        case "/help": return {type: "help"};
        case "/exit": return {type: "exit"};
        case "/skills": return {type: "skills"};
        case "/status": return {type: "status"};
        case "/abort": return {type: "abort"};
        case "/steer": return {type: "steer", text: args.join(" ") || undefined};
        case "/followup": return {type: "followup", text: args.join(" ") || undefined};
        default:
            // 保留原行为：未知 /命令 当成普通输入交给模型。
            return {type: "prompt", text};
    }
}
~~~

/exit 才是退出命令；exit 仍是发给模型的文本。未知命令回退也是保留的行为，不在本任务悄悄改变。

## 3. 新建 src/cli-event-renderer.ts：完整文件

~~~ts
import type {AgentEventListener} from "./agent-events.ts";

/** 只负责显示，不保存 Session、不修改 AgentState。 */
export function createCliEventRenderer(
    write: (text: string) => void,
): AgentEventListener {
    return (event) => {
        if (event.type === "message_update" && event.update.type === "text_delta") {
            write(event.update.delta);
        } else if (event.type === "message_end" && event.message.role === "assistant") {
            write("\n");
        } else if (event.type === "tool_execution_update") {
            write("\n工具进度：" + event.toolName + " " + event.partialResult.content + "\n");
        } else if (event.type === "tool_execution_end") {
            write("\n工具执行状态：" + event.toolName +
                ":" + (event.isError ? "error" : "done") + "\n");
        }
    };
}
~~~

不能在 message_end 再打印 assistant.content，否则同一段回答会显示两次。
toolcall_delta 表示参数生成中，不作为普通文本输出。

## 4. src/cli-agent-runner.ts：完整文件

原 runAgentPrompt 保留，原测试不删除。新的交互式 CLI 使用 createCliRunner 管理后台任务。

~~~ts
import type Agent from "./agent.ts";
import type {CliCommand} from "./cli-command.ts";

export type PromptableAgent = {
    prompt(text: string): Promise<unknown>;
};

/** 保留原单次 Prompt 调用入口，适合顺序执行脚本。 */
export async function runAgentPrompt(
    agent: PromptableAgent,
    text: string,
    onError: (message: string) => void,
): Promise<void> {
    try {
        await agent.prompt(text);
    } catch (error) {
        onError(error instanceof Error ? error.message : String(error));
    }
}

/** 每个 Session 对应一个 Runner，关闭后不再复用。 */
export function createCliRunner(
    agent: Agent,
    write: (text: string) => void,
) {
    let activePrompt: Promise<void> | undefined;
    let closed = false;

    function startPrompt(text: string): void {
        if (closed) {
            write("当前会话控制器已关闭\n");
            return;
        }
        if (activePrompt || agent.state.isRunning) {
            write("Agent 正在运行，请使用 /steer、/followup 或 /abort\n");
            return;
        }

        // 立即调用，使 Agent 的运行锁与 AbortController 同步建立。
        // 不要把 agent.prompt 本身延迟到下一个微任务，否则立即 /abort 会错过它。
        const run = agent.prompt(text);
        const observed = run
            .then((result) => {
                if (result.reason !== "completed") {
                    write("\n本次运行结束：" + result.reason + "\n");
                }
            })
            .catch((error: unknown) => {
                write("\n执行失败：" +
                    (error instanceof Error ? error.message : String(error)) + "\n");
            })
            .finally(() => {
                if (activePrompt === observed) activePrompt = undefined;
            });
        activePrompt = observed;
    }

    /**
     * true：本命令已经处理，main 不再路由。
     * false：交回 main 处理会话、Skill 或普通 Prompt。
     */
    function handleControl(command: CliCommand): boolean {
        if (command.type === "status") {
            write(JSON.stringify({
                isRunning: agent.state.isRunning,
                isSettling: Boolean(activePrompt) && !agent.state.isRunning,
                pendingToolCalls: [...agent.state.pendingToolCalls],
                errorMessage: agent.state.errorMessage,
            }) + "\n");
            return true;
        }
        if (command.type === "abort") {
            agent.abort();
            write("已请求取消；等待当前操作响应并完成收尾\n");
            return true;
        }
        if (command.type === "steer" || command.type === "followup") {
            if (!command.text) {
                write("用法：/" + command.type + " <要求>\n");
            } else if (!agent.state.isRunning) {
                write("当前没有运行中的任务，请直接输入要求\n");
            } else {
                const message = {role: "user" as const, content: command.text};
                if (command.type === "steer") agent.steer(message);
                else agent.followUp(message);
                write("已加入 " + command.type + " 队列\n");
            }
            return true;
        }
        if (
            (command.type === "new" || command.type === "resume") &&
            (activePrompt || agent.state.isRunning)
        ) {
            write("当前任务尚未收尾，请等待完成或先 /abort\n");
            return true;
        }
        return false;
    }

    async function waitForIdle(): Promise<void> {
        await agent.waitForIdle();
        await activePrompt;
    }

    async function close(): Promise<void> {
        closed = true;
        agent.abort();
        await waitForIdle();
    }

    return {
        startPrompt,
        handleControl,
        waitForIdle,
        close,
        get isBusy(): boolean {
            return Boolean(activePrompt) || agent.state.isRunning;
        },
    };
}
~~~

为什么不能只用 state.isRunning 判断切换？agent_end 可能已经把状态改为 false，但结束事件监听器与 finally 还没执行完。activePrompt 覆盖这段“收尾窗口”。

write 回调使用终端输出，要求不要主动抛错。CLI 展示本身的异常不在这里做无限重试。

## 5. src/main.ts：整体替换

这份包含 import、初始化、全部旧命令、新命令接入和退出清理。不保留原 while/question 循环。

~~~ts
import {createInterface} from "node:readline";
import {stdin, stdout} from "node:process";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {createCliRunner} from "./cli-agent-runner.ts";
import {createCliEventRenderer} from "./cli-event-renderer.ts";
import {parseCliCommand} from "./cli-command.ts";
import {RealLlmClient} from "./real-llm.ts";
import {SessionManager} from "./session/session-manager.ts";
import {createSessionAgent} from "./session/create-session-agent.ts";
import type {SessionStore} from "./session/session-store.ts";
import {createToolPolicy} from "./tool-policy.ts";
import {ListDirTool} from "./tools/list-dir-tool.ts";
import {ReadFileTool} from "./tools/read-file-tool.ts";
import {WriteFileTool} from "./tools/write-file-tool.ts";
import {loadSkills} from "./skills/skill-loader.ts";
import {formatSkillInvocation} from "./skills/skill-invocation.ts";
import {formatSkillsForSystemPrompt} from "./skills/system-prompt.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sessionManager = new SessionManager(resolve(projectRoot, "sessions"));
const skills = await loadSkills(resolve(projectRoot, "skills"));
const systemPrompt = [
    "你是一个可调用文件工具的编程助手。遇到策略禁止时应说明原因，不尝试绕过限制。",
    formatSkillsForSystemPrompt(skills),
].filter((part) => part.length > 0).join("\n\n");

const write = (text: string): void => { stdout.write(text); };
const policy = createToolPolicy(async (toolCall) => {
    write("\n准备执行工具：" + toolCall.name + "\n");
    return true;
});

async function createRuntime(store: SessionStore) {
    const agent = await createSessionAgent(store, {
        llm: new RealLlmClient(),
        tools: [
            new ReadFileTool(projectRoot),
            new WriteFileTool(projectRoot),
            new ListDirTool(projectRoot),
        ],
        beforeToolCall: policy,
        systemPrompt,
    });
    agent.subscribe(createCliEventRenderer(write));
    return {agent, runner: createCliRunner(agent, write)};
}

function printHelp(): void {
    write([
        "",
        "可用命令：",
        "  /new                 新建会话",
        "  /sessions            列出会话 ID",
        "  /resume <sessionId>  恢复指定会话",
        "  /skills              列出 Skill",
        "  /skill:<name> <要求> 显式调用 Skill",
        "  /status              查看运行状态",
        "  /abort               请求取消当前运行",
        "  /steer <要求>        当前 Turn 后优先注入",
        "  /followup <要求>     当前任务结束后继续",
        "  /help                查看帮助",
        "  /exit                取消、等待收尾并退出",
        "",
    ].join("\n"));
}

let sessionStore = await sessionManager.create();
let runtime = await createRuntime(sessionStore);
write("已创建会话：" + (await sessionStore.getMetadata()).id + "\n");
printHelp();

const cli = createInterface({input: stdin, output: stdout, prompt: "\n你> "});
// Ctrl+C 与 /exit 一样走 finally，不调用 process.exit 强行结束。
cli.on("SIGINT", () => {
    runtime.agent.abort();
    cli.close();
});
cli.prompt();

try {
    // 输入按行进入；不等待模型 Prompt，因此运行控制命令能够到达。
    // 会话创建/恢复仍按命令顺序 await，避免多个会话操作互相覆盖。
    for await (const input of cli) {
        try {
            const command = parseCliCommand(input);
            if (command.type === "exit") break;
            if (runtime.runner.handleControl(command)) {
                cli.prompt();
                continue;
            }

            switch (command.type) {
                case "empty":
                    break;
                case "help":
                    printHelp();
                    break;
                case "new": {
                    const nextStore = await sessionManager.create();
                    const nextRuntime = await createRuntime(nextStore);
                    // 新装配成功后才替换；失败仍保留原会话。
                    await runtime.runner.close();
                    sessionStore = nextStore;
                    runtime = nextRuntime;
                    write("已创建会话：" + (await sessionStore.getMetadata()).id + "\n");
                    break;
                }
                case "resume": {
                    if (!command.sessionId) {
                        write("用法：/resume <sessionId>\n");
                        break;
                    }
                    const nextStore = await sessionManager.open(command.sessionId);
                    const nextRuntime = await createRuntime(nextStore);
                    await runtime.runner.close();
                    sessionStore = nextStore;
                    runtime = nextRuntime;
                    write("已恢复会话：" + command.sessionId + "\n");
                    break;
                }
                case "list": {
                    const ids = await sessionManager.listSessionIds();
                    write(ids.length ? "历史会话：\n" + ids.join("\n") + "\n" : "暂无历史会话\n");
                    break;
                }
                case "skills":
                    write(skills.length
                        ? skills.map((skill) => skill.name + ": " + skill.description).join("\n") + "\n"
                        : "当前没有可用 Skill\n");
                    break;
                case "skill": {
                    const skill = skills.find((item) => item.name === command.name);
                    if (!skill) {
                        write("找不到 Skill：" + command.name + "\n");
                        break;
                    }
                    runtime.runner.startPrompt(
                        formatSkillInvocation(skill, command.additionalInstructions),
                    );
                    break;
                }
                case "prompt":
                    runtime.runner.startPrompt(command.text);
                    break;
                // 以下命令已经由 handleControl 处理，不读取不存在的 command.text。
                case "status":
                case "abort":
                case "steer":
                case "followup":
                    break;
            }
        } catch (error) {
            write("\n命令执行失败：" +
                (error instanceof Error ? error.message : String(error)) + "\n");
        }
        cli.prompt();
    }
} finally {
    cli.close();
    await runtime.runner.close();
}
~~~

注意四点：

1. 不再调用 await runAgentPrompt；普通输入与 Skill 都走 startPrompt。
2. 新会话装配失败不会覆盖旧 runtime；但新建的空 JSONL 可能已产生，不自动删除。
3. 如果此前配置了 afterToolCall、maxTurns 等，把配置保留在 createSessionAgent 的 options 中。
4. 这里保留原 policy 的确认回调行为：返回 true，不代表新增了交互授权。不要在工具回调里另开 readline 抢输入。

这是学习版 CLI，不是 TUI。模型文字与正在输入的行可能视觉交错；不影响命令到达。光标重绘、输入区分离是后续 UI 功能，不要塞进 Loop。

## 6. 新增测试：三个完整文件

### 6.1 test/cli-command.test.ts

~~~ts
import assert from "node:assert/strict";
import test from "node:test";
import {parseCliCommand} from "../src/cli-command.ts";

test("解析运行控制与原命令", () => {
    assert.deepEqual(parseCliCommand("/status"), {type: "status"});
    assert.deepEqual(parseCliCommand("/abort"), {type: "abort"});
    assert.deepEqual(parseCliCommand("/steer 改成 只读"), {type: "steer", text: "改成 只读"});
    assert.deepEqual(parseCliCommand("/followup 总结"), {type: "followup", text: "总结"});
    assert.deepEqual(parseCliCommand("/steer"), {type: "steer", text: undefined});
    assert.deepEqual(parseCliCommand("/new"), {type: "new"});
    assert.deepEqual(parseCliCommand("/resume abc"), {type: "resume", sessionId: "abc"});
    assert.deepEqual(parseCliCommand("/sessions"), {type: "list"});
    assert.deepEqual(parseCliCommand("/skills"), {type: "skills"});
    assert.deepEqual(parseCliCommand("/skill:dev 检查代码"), {
        type: "skill", name: "dev", additionalInstructions: "检查代码",
    });
});

test("exit 文本和 /exit 命令不同；保留未知命令回退", () => {
    assert.deepEqual(parseCliCommand("exit"), {type: "prompt", text: "exit"});
    assert.deepEqual(parseCliCommand("/exit"), {type: "exit"});
    assert.deepEqual(parseCliCommand("/unknown"), {type: "prompt", text: "/unknown"});
    assert.deepEqual(parseCliCommand(" "), {type: "empty"});
});
~~~

### 6.2 test/cli-event-renderer.test.ts

~~~ts
import assert from "node:assert/strict";
import test from "node:test";
import {createCliEventRenderer} from "../src/cli-event-renderer.ts";

test("只打印文本增量，message_end 不重复打印全文", async () => {
    const output: string[] = [];
    const render = createCliEventRenderer((text) => { output.push(text); });
    await render({
        type: "message_update",
        message: {role: "assistant", content: "你好"},
        update: {type: "text_delta", delta: "你好"},
    });
    await render({
        type: "message_update",
        message: {role: "assistant", content: "你好"},
        update: {type: "toolcall_delta"},
    });
    await render({type: "message_end", message: {role: "assistant", content: "你好"}});
    await render({
        type: "tool_execution_update", toolCallId: "c1", toolName: "echo",
        partialResult: {content: "50%"},
    });
    await render({
        type: "tool_execution_end", toolCallId: "c1", toolName: "echo",
        result: {content: "完成"}, isError: false,
    });
    assert.deepEqual(output, [
        "你好", "\n", "\n工具进度：echo 50%\n", "\n工具执行状态：echo:done\n",
    ]);
});
~~~

### 6.3 test/cli-runtime.test.ts

~~~ts
import assert from "node:assert/strict";
import test from "node:test";
import Agent from "../src/agent.ts";
import {FakeLlmClient} from "../src/fake-llm.ts";
import {createCliRunner} from "../src/cli-agent-runner.ts";

test("运行中能 abort/status，不能切会话或启动第二个 Prompt", async () => {
    const llm = new FakeLlmClient([]);
    const agent = new Agent({llm, tools: []});
    const output: string[] = [];
    const runner = createCliRunner(agent, (text) => { output.push(text); });
    // 人工暂停 agent_start，确定性地制造运行中状态，不依赖定时器。
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    agent.subscribe(async (event) => {
        if (event.type === "agent_start") await gate;
    });

    runner.startPrompt("开始");
    assert.equal(runner.isBusy, true);
    assert.equal(runner.handleControl({type: "new"}), true);
    assert.equal(runner.handleControl({type: "resume", sessionId: "other"}), true);
    assert.equal(runner.handleControl({type: "status"}), true);
    runner.startPrompt("重复");
    assert.equal(runner.handleControl({type: "abort"}), true);
    release();
    await runner.waitForIdle();

    assert.equal(agent.state.isRunning, false);
    assert.equal(runner.isBusy, false);
    assert.equal(llm.requests.length, 0);
    assert.match(output.join(""), /正在运行/);
    assert.match(output.join(""), /aborted/);
    assert.equal(runner.handleControl({type: "new"}), false);
    await runner.close();
});

test("CLI steer/followup 路由到双层 Loop，顺序不变", async () => {
    const llm = new FakeLlmClient([
        {role: "assistant", content: "原任务"},
        {role: "assistant", content: "新方向"},
        {role: "assistant", content: "总结"},
    ]);
    const agent = new Agent({llm, tools: []});
    const output: string[] = [];
    const runner = createCliRunner(agent, (text) => { output.push(text); });
    runner.handleControl({type: "steer", text: "空闲指令"});
    assert.match(output.join(""), /没有运行中的任务/);

    runner.startPrompt("开始");
    runner.handleControl({type: "followup", text: "最后总结"});
    runner.handleControl({type: "steer", text: "改为只读"});
    await runner.waitForIdle();
    assert.equal(llm.requests.length, 3);
    assert.equal(llm.requests[1]?.messages.at(-1)?.content, "改为只读");
    assert.equal(llm.requests[2]?.messages.at(-1)?.content, "最后总结");
    await runner.close();
});

test("模型失败能被报告，CLI 可以再次提交 Prompt", async () => {
    let fail = true;
    const agent = new Agent({
        llm: new FakeLlmClient([{role: "assistant", content: "恢复"}]),
        tools: [],
        transformContext: async (messages) => {
            if (fail) { fail = false; throw new Error("测试失败"); }
            return messages;
        },
    });
    const output: string[] = [];
    const runner = createCliRunner(agent, (text) => { output.push(text); });
    runner.startPrompt("第一次");
    await runner.waitForIdle();
    assert.match(output.join(""), /执行失败：测试失败/);
    runner.startPrompt("第二次");
    await runner.waitForIdle();
    assert.equal(agent.state.messages.at(-1)?.content, "恢复");
    await runner.close();
});

test("close 取消并等待运行收尾，关闭后不再接受 Prompt", async () => {
    const agent = new Agent({llm: new FakeLlmClient([]), tools: []});
    const output: string[] = [];
    const runner = createCliRunner(agent, (text) => { output.push(text); });
    runner.startPrompt("开始");
    await runner.close();
    assert.equal(runner.isBusy, false);
    runner.startPrompt("不能再开始");
    assert.match(output.join(""), /已关闭/);
});
~~~

测试只调用控制器和真实 Agent，不启动真实模型。readline 的终端显示效果单独手工验收。

## 7. 验证、命令清单与断点

在 package.json 的 scripts.test 末尾追加：

~~~text
test/cli-command.test.ts test/cli-event-renderer.test.ts test/cli-runtime.test.ts
~~~

保留 test/cli-agent-runner.test.ts。

~~~powershell
npx tsx --test test/cli-command.test.ts test/cli-event-renderer.test.ts test/cli-runtime.test.ts test/cli-agent-runner.test.ts
npm run check
npm test
npm run dev
~~~

真实 CLI 验证会使用配置的模型并产生调用费用，按需手动执行：

| 输入场景 | 预期 |
|---|---|
| 输入普通问题后立即 /status | 不必等模型结束即可显示状态 |
| 运行中 /new、/resume | 明确拒绝，不替换 Session |
| 运行中 /steer 只读 | 当前 Turn 后优先加入 user |
| 运行中 /followup 最后总结 | 原任务结束后才处理 |
| 运行中 /abort | 请求取消，打印 aborted，随后可继续输入 |
| 任务结束后 /new、/resume | 可以正常切换 |
| /skill:agent-ts-development 检查项目 | 仍走 Skill 格式化，再后台 Prompt |
| /exit 或 Ctrl+C | 取消、等待清理、退出 |

不要在同一个 Agent 的事件监听器中 await runner.close()/waitForIdle()，会互相等待。清理应由 CLI 外部调用。

断点顺序：parseCliCommand → handleControl/startPrompt → Agent.startRun → createCliEventRenderer → Runner.finally。

建议提交：

~~~text
feat(agent): 支持 CLI 后台运行与交互控制命令
~~~

## 8. 通俗说明

~~~text
输入普通文本 → Runner.startPrompt → Agent.prompt（不阻塞输入循环）
输入 /abort → Runner.handleControl → Agent.abort
输入 /new   → 检查 Runner 是否忙 → Store + 新 Agent + 新 Runner
AgentEvent  → SessionListener 保存 → CliEventRenderer 显示
退出        → Runner.close → abort → waitForIdle
~~~

后台运行不是另开线程，而是不在输入循环中等待那个 Promise。模型和文件 I/O 等待期间，JavaScript 能继续处理下一行命令。

main 是装配与路由；Runner 管一次会话的后台任务；Agent 管真正的执行。这样将来换成 HTTP 或 TUI，复用的是 Agent 和 Session 工厂，不需要搬走整个 main。
