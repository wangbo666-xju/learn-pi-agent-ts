import Agent from "./agent.ts";

import {RealLlmClient} from "./real-llm.ts";
import {ReadFileTool} from "./tools/read-file-tool.ts";
import {WriteFileTool} from "./tools/write-file-tool.ts";
import {ListDirTool} from "./tools/list-dir-tool.ts";
import {createToolPolicy} from "./tool-policy.ts";
import {existsSync} from "node:fs";
import {randomUUID} from "node:crypto";
import {resolve} from "node:path";
import {JsonlSessionStore} from "./session/jsonl-session-store.ts";
import { SessionManager } from "./session/session-manager.ts";

let cwd = process.cwd();


const sessionManager = new SessionManager(resolve("sessions"));
const sessionStore = await sessionManager.create();

const policy = createToolPolicy(async (toolCall) => {
    console.log("准备执行工具：", toolCall.name, toolCall.arguments);
    return true; // 现在先默认允许，之后 main 整体可以废弃
});

const llm = new RealLlmClient();
const agent = new Agent(llm, [new ReadFileTool(cwd), new WriteFileTool(cwd), new ListDirTool(cwd)], policy, sessionStore);

await agent.prompt("你创建一个叫helloworld的txt文件,然后把代码写入java的helloworld");