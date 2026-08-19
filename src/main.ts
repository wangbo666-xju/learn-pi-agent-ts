import Agent from "./agent.ts"
import {RealLlmClient} from "./real-llm.ts";
import {ReadFileTool} from "./read-file-tool.ts";

const agent = new Agent(
    new RealLlmClient(),
    [new ReadFileTool()],
);

await agent.prompt("读取 README.md，并用一句话总结它的内容。");