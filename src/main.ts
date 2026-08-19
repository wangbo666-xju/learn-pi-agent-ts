import Agent from "./agent.ts"
import {RealLlmClient} from "./real-llm.ts";
import {ReadFileTool} from "./read-file-tool.ts";

const agent = new Agent(
    new RealLlmClient(),
    [new ReadFileTool()],
);

await agent.prompt("请只回复：真实模型连接成功");