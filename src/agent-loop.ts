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
    Tool, ToolResultMessage, UserMessage,
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
    signal?: AbortSignal;
    pollSteering?: () => UserMessage[];
    pollFollowUp?: () => UserMessage[];
    shouldStopAfterTurn?: (
        input: {
            message: AssistantMessage;
            toolResults: ToolResultMessage[];
            context: AgentContext;
            newMessages: AgentMessage[];
        },
        signal?: AbortSignal,
    ) => boolean | Promise<boolean>;
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
    let turn = 0;

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

    /** 完整的 user/toolResult 消息统一按此顺序追加并通知保存。 */
    async function appendAndEmitMessages(messages: AgentMessage[]): Promise<void> {
        for (const message of messages) {
            await emit({type: "message_start", message});
            context.messages.push(message);
            newMessages.push(message);
            await emit({type: "message_end", message});
        }
    }

    /** 一轮 = 请求一次模型 + 执行其返回的整批工具 + 发布 turn_end。 */
    async function runTurn(): Promise<{
        reply: AssistantMessage;
        toolResults: ToolResultMessage[];
    }> {
        await emit({type: "turn_start", turn});
        config.signal?.throwIfAborted();

        const llmMessages = await prepareLlmContext(
            context.messages,
            config.transformContext ?? identityTransformContext,
            config.convertToLlm ?? defaultConvertToLlm,
            config.signal,
        );
        config.signal?.throwIfAborted();

        let assistantWasAdded = false;
        const reply = await config.llm.chatStream(
            llmMessages,
            context.tools,
            async (event) => {
                config.signal?.throwIfAborted();

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
                } else if (event.type === "done") {
                    context.messages.push(event.message);
                    newMessages.push(event.message);
                    assistantWasAdded = true;
                    await emit({type: "message_end", message: event.message});
                }
            },
            {
                systemPrompt: context.systemPrompt,
                signal: config.signal,
            },
        );

        // 保留 Task 3 的兼容路径：某个 LLM 只返回结果而未发布 done 时仍追加一次。
        if (!assistantWasAdded) {
            config.signal?.throwIfAborted();
            context.messages.push(reply);
            newMessages.push(reply);
            await emit({type: "message_end", message: reply});
        }
        finalMessage = reply;

        // Task 4 的工具尚未接收 signal。
        // assistant 工具调用已入历史后，完成整批工具结果，再在 Turn 边界响应取消。
        const {results} = await executeTools(context.tools, reply, {
            beforeToolCall: config.beforeToolCall,
            emit,
        });

        await appendAndEmitMessages(results);
        await emit({
            type: "turn_end",
            turn,
            message: reply,
            toolResults: results,
        });
        return {reply, toolResults: results};


    }

    try {
        // 整个生命周期都必须在 try 内。message_end 持久化失败时仍要进入错误收尾。
        await emit({type: "agent_start"});
        config.signal?.throwIfAborted();
        if (!Number.isInteger(config.maxTurns) || config.maxTurns < 1) {
            throw new Error("maxTurns 必须是正整数");
        }

        let pendingMessages = [...initialMessages];

        // 外层负责初始输入，以及当前任务完成后的 followUp。
        // 必须 do/while：continue() 传 [] 时也需要执行第一次模型请求。
        do {
            config.signal?.throwIfAborted();

            await appendAndEmitMessages(pendingMessages);
            pendingMessages = [];

            while (true) {
                turn++;
                if (turn > config.maxTurns) return finish("max_turns");

                const {reply, toolResults} = await runTurn();
                config.signal?.throwIfAborted();


                const shouldStop = await config.shouldStopAfterTurn?.({
                    message: reply,
                    toolResults,
                    context,
                    newMessages,
                }, config.signal);
                config.signal?.throwIfAborted();
                if (shouldStop) return await finish("terminated");


                // 用完预算且仍需要继续时，不能取走队列消息却不处理。
                if (turn >= config.maxTurns) {
                    // 无工具且没有队列时，第 N 轮直接回答仍属于正常完成。
                    // 是否有队列由下面轮询确定；轮询得到的消息会先记录再结束。
                    if (toolResults.length > 0) return await finish("max_turns");
                }

                const steering = config.pollSteering?.() ?? [];
                if (steering.length > 0) {
                    await appendAndEmitMessages(steering);
                    continue;
                }
                if (toolResults.length > 0) {
                    continue;
                }

                break;

            }
            pendingMessages = config.pollFollowUp?.() ?? [];

        } while (pendingMessages.length > 0);
        return await finish("completed");
    } catch (error) {
        // 已尝试发布 agent_end 后，监听器异常仍向上传播，不能伪装成取消成功。
        if (agentEnded) throw error;
        if (config.signal?.aborted) return await finish("aborted");
        await emitAgentEnd("error");
        throw error;
    }
}