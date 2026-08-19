import Agent from "./agent.ts";
import {RealLlmClient} from "./real-llm.ts";
import {ReadFileTool} from "./read-file-tool.ts";

const llm = new RealLlmClient();
const agent = new Agent(llm, [new ReadFileTool()]);

await agent.prompt("读取 Readme.md 的内容，然后用三句话总结这个项目是干什么的。");