import {AgentMessage, LlmClient, Tool} from "./types.ts";
import * as repl from "node:repl";

class Agent {

    private readonly llm: LlmClient;
    private readonly tools: Tool[];


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

        while (true) {
            const reply = await this.llm.chat(messages, this.tools);
            messages.push(reply);

            if (!reply.toolCalls?.length) {
                console.log(reply.content);
                return messages;
            }

            for (let toolCall of reply.toolCalls) {
                const tool = this.tools.find((i) => i.name == toolCall.name)

                if (!tool) {
                    messages.push({
                        role: "toolResult",
                        toolCallId: toolCall.id,
                        content: `找不到工具：${toolCall.name}`,
                    });
                    continue;
                }

                let result: string;

                try {
                    result = await tool.execute(toolCall.arguments);

                } catch (error) {
                    const msg = error instanceof Error ? error.message : String(error);
                    result = `工具执行失败: ${msg}`;
                }

                messages.push({
                    role: "toolResult",
                    content: result,
                    toolCallId: toolCall.id
                })

            }


        }

    }

}

export default Agent