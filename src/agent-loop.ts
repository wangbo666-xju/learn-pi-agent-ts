import type {AgentEventListener, AgentStopReason} from "./agent-events.ts";
import type {ConvertToLlm, TransformContext} from "./context.ts";
import {
    defaultConvertToLlm,
    identityTransformContext,
    prepareLlmContext,
} from "./context.ts";
import type {
    AgentMessage,
    AssistantMessage,
    BeforeToolCall,
    LlmClient,
    Tool,
} from "./types.ts";
import {executeTools} from "./execute-tools.ts";


export type AgentContext = {
    systemPrompt: string;
    messages: AgentMessage[];
    tools: Tool[];
};


export type AgentRunResult = {
    newMessages: AgentMessage[];
    finalMessage?: AssistantMessage;
    reason: AgentStopReason;
};


export type AgentLoopConfig = {
    llm: LlmClient;
    maxTurns: number;
    emit: AgentEventListener;
    beforeToolCall?: BeforeToolCall;
    transformContext?: TransformContext;
    convertToLlm?: ConvertToLlm;
};


export async function runAgentLoop(
    initialMessages: AgentMessage[],
    context: AgentContext,
    config: AgentLoopConfig,
): Promise<AgentRunResult> {
    const newMessages: AgentMessage[] = [];
    const emit = config.emit;
    let finalMessage: AssistantMessage | undefined;
    let agentEnded = false;

    async function emitAgentEnd(reason: AgentStopReason): Promise<void> {
        if (agentEnded) return;
        // 先置位再发布；即使某个 agent_end 监听器报错，也不能重复发布。
        agentEnded = true;
        await emit({type: "agent_end", reason, newMessages});
    }

    async function finish(reason: AgentStopReason): Promise<AgentRunResult> {
        const result: AgentRunResult = {newMessages, finalMessage, reason};
        await emitAgentEnd(reason);
        return result;
    }

    try {
        // 整个生命周期都必须在 try 内。message_end 持久化失败时仍要进入错误收尾。
        await emit({type: "agent_start"});

        for (const message of initialMessages) {
            await emit({type: "message_start", message});
            context.messages.push(message);
            newMessages.push(message);
            await emit({type: "message_end", message});
        }

        for (let turn = 1; turn <= config.maxTurns; turn++) {
            await emit({type: "turn_start", turn});

            const llmMessages = await prepareLlmContext(
                context.messages,
                config.transformContext ?? identityTransformContext,
                config.convertToLlm ?? defaultConvertToLlm,
            );

            let assistantWasAdded = false;
            const reply = await config.llm.chatStream(
                llmMessages,
                context.tools,
                async (event) => {
                    if (event.type === "start") {
                        await emit({type: "message_start", message: event.partial});
                    } else if (event.type === "text_delta") {
                        await emit({
                            type: "message_update",
                            message: event.partial,
                            update: {type: "text_delta", delta: event.delta},
                        });
                    } else if (event.type === "toolcall_delta") {
                        await emit({
                            type: "message_update",
                            message: event.partial,
                            update: {type: "toolcall_delta"},
                        });
                    } else {
                        context.messages.push(event.message);
                        newMessages.push(event.message);
                        assistantWasAdded = true;
                        await emit({type: "message_end", message: event.message});
                    }
                },
                {systemPrompt: context.systemPrompt},
            );

            if (!assistantWasAdded) {
                context.messages.push(reply);
                newMessages.push(reply);
                await emit({type: "message_end", message: reply});
            }

            finalMessage = reply;
            const {results} = await executeTools(
                context.tools,
                reply,
                {
                    beforeToolCall: config.beforeToolCall,
                    emit,
                },
            );

            for (const result of results) {
                await emit({type: "message_start", message: result});
                context.messages.push(result);
                newMessages.push(result);
                await emit({type: "message_end", message: result});
            }

            await emit({type: "turn_end", turn, message: reply, toolResults: results});

            if (results.length === 0) return finish("completed");
        }

        return finish("max_turns");
    } catch (error) {
        await emitAgentEnd("error");
        throw error;
    }
}