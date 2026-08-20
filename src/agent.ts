import type {AgentMessage, LlmClient, Tool} from "./types.ts";
import {executeTools} from "./execute-tools.ts";

class Agent {

    private readonly llm: LlmClient;
    private readonly tools: Tool[];
    private readonly maxTurns = 10;


    constructor(llm: LlmClient, tools: Tool[]) {
        this.llm = llm;
        this.tools = tools;
    }

    async prompt(text: string): Promise<AgentMessage[]> {
        const messages: AgentMessage[] = [];

        messages.push({
            role: "user",
            content: text,
        });

        let step = 0;
        while (true) {
            step++;
            if (step > this.maxTurns) {
                throw new Error("工具调用轮数超限。")
            }
            const reply = await this.llm.chatStream(messages, this.tools, (text) => process.stdout.write(text));
            messages.push(reply);

            if (!reply.toolCalls?.length) {
                if (reply.content) {
                    process.stdout.write("\n");   // 文本已经实时打过了，这里只补个换行
                }
                return messages;
            }

            const {contexts, results} = await executeTools(this.tools, reply);
            messages.push(...results);
            console.log("工具执行状态：", contexts.map((c) => `${c.name}:${c.state}`));

            process.stdout.write("\n");


        }

    }

}

export default Agent