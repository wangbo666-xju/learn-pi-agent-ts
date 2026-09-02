import {createInterface} from "node:readline/promises";
import {stdin, stdout} from "node:process";

import Agent from "./agent.ts";
import {runAgentPrompt} from "./cli-agent-runner.ts";
import {parseCliCommand} from "./cli-command.ts";
import {RealLlmClient} from "./real-llm.ts";
import {SessionManager} from "./session/session-manager.ts";
import type {SessionStore} from "./session/session-store.ts";
import {createToolPolicy} from "./tool-policy.ts";
import {ListDirTool} from "./tools/list-dir-tool.ts";
import {ReadFileTool} from "./tools/read-file-tool.ts";
import {WriteFileTool} from "./tools/write-file-tool.ts";
import {loadSkills} from "./skills/skill-loader.ts";
import {formatSkillInvocation} from "./skills/skill-invocation.ts";
import {formatSkillsForSystemPrompt} from "./skills/system-prompt.ts";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";

// main.ts 位于 <项目根目录>/src/，因此向上一层得到项目根目录。
// 不依赖 IDEA 的 Working directory。
const sourceDir = dirname(
    fileURLToPath(import.meta.url),
);

const projectRoot = resolve(sourceDir, "..");

const cwd = projectRoot;

const sessionManager = new SessionManager(
    resolve(projectRoot, "sessions"),
);

const skills = await loadSkills(
    resolve(projectRoot, "skills"),
);

const systemPrompt = [
    "你是一个可调用文件工具的编程助手。",
    formatSkillsForSystemPrompt(skills),
]
    .filter((part) => part.length > 0)
    .join("\n\n");

const policy = createToolPolicy(async (toolCall) => {
    console.log("准备执行工具：", toolCall.name, toolCall.arguments);
    return true;
});

function createAgent(sessionStore: SessionStore): Agent {
    const llm = new RealLlmClient();

    return new Agent(
        llm,
        [
            new ReadFileTool(cwd),
            new WriteFileTool(cwd),
            new ListDirTool(cwd),
        ],
        policy,
        sessionStore,
        systemPrompt,
    );
}

function printHelp(): void {
    console.log(`
可用命令：
  /new                 新建一个会话
  /sessions            查看全部会话 ID
  /resume <sessionId>  恢复指定会话
  /help                查看帮助
  /exit                退出程序
  /skills              查看可用 Skill
  /skill:<name> <要求> 显式调用一个 Skill
`);
}

let sessionStore = await sessionManager.create();
let agent = createAgent(sessionStore);


const metadata = await sessionStore.getMetadata();
console.log(`已创建会话：${metadata.id}`);
printHelp();

const cli = createInterface({
    input: stdin,
    output: stdout,
});


try {
    while (true) {
        const input = await cli.question("\n你> ");
        const command = parseCliCommand(input);

        if (command.type === "empty") {
            continue;
        }

        if (command.type === "help") {
            printHelp();
            continue;
        }

        if (command.type === "exit") {
            break;
        }

        if (command.type === "new") {
            sessionStore = await sessionManager.create();
            agent = createAgent(sessionStore);

            const newMetadata = await sessionStore.getMetadata();
            console.log(`已创建会话：${newMetadata.id}`);
            continue;
        }

        if (command.type === "list") {
            const sessionIds = await sessionManager.listSessionIds();
            if (sessionIds.length === 0) {
                console.log("暂无历史会话。");
            } else {
                console.log("历史会话：");
                for (const sessionId of sessionIds) {
                    console.log(`- ${sessionId}`);
                }
            }
            continue;
        }


        if (command.type === "resume") {
            if (!command.sessionId) {
                console.log("用法：/resume <sessionId>");
                continue;
            }

            try {
                sessionStore = await sessionManager.open(command.sessionId);
                agent = createAgent(sessionStore);
                console.log(`已恢复会话：${command.sessionId}`);

            } catch (error) {
                const message = error instanceof Error
                    ? error.message
                    : String(error);
                console.log(`恢复会话失败：${message}`);
            }
            continue;

        }

        if (command.type === "skills") {
            if (skills.length === 0) {
                console.log("当前没有可用 Skill。");
            } else {
                console.log("可用 Skill：");

                for (const skill of skills) {
                    console.log(`- ${skill.name}: ${skill.description}`);
                }
            }

            continue;
        }

        if (command.type === "skill") {
            const skill = skills.find(
                (item) => item.name === command.name,
            );

            if (!skill) {
                console.log(`找不到 Skill：${command.name}`);
                continue;
            }

            await runAgentPrompt(
                agent,
                formatSkillInvocation(
                    skill,
                    command.additionalInstructions,
                ),
                (message) => console.log(`\n执行失败：${message}`),
            );

            continue;
        }

        await runAgentPrompt(
            agent,
            command.text,
            (message) => console.log(`\n执行失败：${message}`),
        );


    }
} finally {
    cli.close();
}
