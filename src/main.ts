import {createInterface} from "node:readline";
import {stdin, stdout} from "node:process";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {createCliRunner} from "./cli-agent-runner.ts";
import {createCliEventRenderer} from "./cli-event-renderer.ts";
import {parseCliCommand} from "./cli-command.ts";
import {RealLlmClient} from "./real-llm.ts";
import {SessionManager} from "./session/session-manager.ts";
import {createSessionRuntime} from "./session/session-runtime.ts";
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
    // 普通对话和摘要复用同一个模型适配器；压缩不走 Agent 的工具循环。
    const llm = new RealLlmClient();
    const agent = await createSessionRuntime(store, {
        llm,
        tools: [
            new ReadFileTool(projectRoot),
            new WriteFileTool(projectRoot),
            new ListDirTool(projectRoot),
        ],
        beforeToolCall: policy,
        systemPrompt,
        // 应用预算，不是自动识别的模型上限；切模型时按实际窗口调整环境变量。
        autoCompact: {
            contextWindowTokens: Number(process.env.AGENT_CONTEXT_WINDOW ?? 32768),
            reserveTokens: Number(process.env.AGENT_COMPACT_RESERVE ?? 4096),
        },
        onCompaction: (event) => {
            if (event.type === "auto_compaction_start") {
                write(event.reason === "overflow"
                    ? "\n上下文溢出，正在压缩后恢复…\n"
                    : "\n上下文接近预算，正在自动压缩…\n");
            } else {
                write(event.error ? "\n自动压缩未完成：" + event.error + "\n" : "\n自动压缩完成\n");
            }
        },
    });
    agent.subscribe(createCliEventRenderer(write));
    return {
        agent,
        runner: createCliRunner(agent, write, (signal) => agent.compact(signal)),
    };
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
        "  /compact             压缩旧对话，保留最近两组消息",
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
function requestExit(): void {
    runtime.runner.abort();
    cli.close();
}
cli.on("SIGINT", requestExit);
// IDEA/管道输入可能不是 TTY，进程信号不一定经过 readline。
process.on("SIGINT", requestExit);
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
                case "compact":
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
    try {
        await runtime.runner.close();
    } finally {
        process.off("SIGINT", requestExit);
        cli.off("SIGINT", requestExit);
    }
}
