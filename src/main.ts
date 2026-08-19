import { RealLlmClient } from "./real-llm.ts";

const llm = new RealLlmClient();

await llm.streamText("用10句话解释什么是 Agent Loop。");