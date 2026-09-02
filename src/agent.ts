import type {AgentMessage, BeforeToolCall, LlmClient, Tool} from "./types.ts";
import {executeTools} from "./execute-tools.ts";
import type {SessionStore} from "./session/session-store.ts";


class Agent {

    private readonly llm: LlmClient;
    private readonly tools: Tool[];
    private readonly maxTurns = 10;
    private readonly beforeToolCall?: BeforeToolCall;
    private readonly sessionStore: SessionStore;
    private readonly systemPrompt: string;

    constructor(llm: LlmClient, tools: Tool[], beforeToolCall: BeforeToolCall, sessionStore: SessionStore, systemPrompt = "",) {
        this.llm = llm;
        this.tools = tools;
        this.beforeToolCall = beforeToolCall;
        this.sessionStore = sessionStore;
        this.systemPrompt = systemPrompt;
    }

    async prompt(text: string): Promise<AgentMessage[]> {
        // 不再从空数组开始，而是恢复当前 Session 的历史。
        const messages = await this.sessionStore.getMessages();

        const userMessage: AgentMessage = {
            role: "user",
            content: text,
        };

        messages.push(userMessage);

        // user 消息形成后立即保存。
        await this.sessionStore.appendMessage(userMessage);

        let step = 0;
        while (true) {
            step++;
            if (step > this.maxTurns) {
                throw new Error("工具调用轮数超限。")
            }

            const reply = await this.llm.chatStream(
                messages,
                this.tools,
                (text) => process.stdout.write(text),
                {
                    systemPrompt: this.systemPrompt,
                },
            );

            messages.push(reply);

            // 流结束后才保存完整 assistant 消息。
            // text_delta 阶段不落库。
            await this.sessionStore.appendMessage(reply);

            if (!reply.toolCalls?.length) {
                if (reply.content) {
                    process.stdout.write("\n");   // 文本已经实时打过了，这里只补个换行
                }
                return messages;
            }

            const {contexts, results} = await executeTools(this.tools, reply, this.beforeToolCall);
            messages.push(...results);

            // 每条 toolResult 都是完整 AgentMessage，需要进入 Session。
            for (const result of results) {
                await this.sessionStore.appendMessage(result);
            }

            console.log("工具执行状态：", contexts.map((c) => `${c.name}:${c.state}`));

            process.stdout.write("\n");


        }

    }

}

export default Agent
