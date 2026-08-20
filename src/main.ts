import Agent from "./agent.ts";

import {RealLlmClient} from "./real-llm.ts";
import {ReadFileTool} from "./tools/read-file-tool.ts";
import {WriteFileTool} from "./tools/write-file-tool.ts";
import {ListDirTool} from "./tools/list-dir-tool.ts";

let cwd = process.cwd();


const llm = new RealLlmClient();
const agent = new Agent(llm, [new ReadFileTool(cwd), new WriteFileTool(cwd), new ListDirTool(cwd)]);

await agent.prompt("读取 Readme.md 的内容，然后用三句话总结这个项目是干什么的,最后把里边的内容改成helloworld。");