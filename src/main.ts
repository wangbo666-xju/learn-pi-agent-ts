import Agent from "./agent.ts"
import {RealLlmClient} from "./real-llm.ts";
import {ReadFileTool} from "./read-file-tool.ts";

const agent = new Agent(
    new RealLlmClient(),
    [new ReadFileTool()],
);

await agent.prompt("读取不存在的文件 not-exists.md，并根据结果回答。");