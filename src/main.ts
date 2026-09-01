import {createInterface} from "node:readline/promises";
import {stdin, stdout} from "node:process";
import {resolve} from "node:path";

import Agent from "./agent.ts";
import {parseCliCommand} from "./cli-command.ts";
import {RealLlmClient} from "./real-llm.ts";
import {SessionManager} from "./session/session-manager.ts";
import type {SessionStore} from "./session/session-store.ts";
import {createToolPolicy} from "./tool-policy.ts";
import {ListDirTool} from "./tools/list-dir-tool.ts";
import {ReadFileTool} from "./tools/read-file-tool.ts";
import {WriteFileTool} from "./tools/write-file-tool.ts";

const cwd = process.cwd();
const sessionManager = new SessionManager(resolve("sessions"));


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
            let sessionStore = await sessionManager.create();
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

        try {
            await agent.prompt(command.text);
        } catch (error) {
            const message = error instanceof Error
                ? error.message
                : String(error);
            console.log(`\n执行失败：${message}`);
        }


    }
} finally {
    cli.close();
}