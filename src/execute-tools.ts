import type {AgentEventListener} from "./agent-events.ts";
import {validateToolArguments} from "./tool-arguments.ts";
import type {
    AfterToolCall,
    AssistantMessage,
    BeforeToolCall,
    Tool,
    ToolExecutionResult,
    ToolResultMessage,
    ToolRunContext,
} from "./types.ts";

export type ExecuteToolsOptions = {
    beforeToolCall?: BeforeToolCall;
    afterToolCall?: AfterToolCall;
    emit?: AgentEventListener;
    signal?: AbortSignal;
};


export type ExecuteToolsResult = {
    contexts: ToolRunContext[];
    results: ToolResultMessage[];
    allTerminated: boolean;
};

export async function executeTools(
    tools: Tool[],
    message: AssistantMessage,
    options: ExecuteToolsOptions = {},
): Promise<ExecuteToolsResult> {
    const results: ToolResultMessage[] = [];
    const contexts: ToolRunContext[] = [];
    const outcomes: ToolExecutionResult[] = [];

    // 学习版固定串行。同一批次取消后，剩余调用不执行，但仍补错误结果。
    for (const toolCall of message.toolCalls ?? []) {
        const context: ToolRunContext = {
            id: toolCall.id,
            name: toolCall.name,
            state: "running",
            startedAt: Date.now(),
            input: toolCall.arguments,
        };
        // 事件订阅失败属于基础设施错误，不能伪装成工具业务错误。
        await options.emit?.({
            type: "tool_execution_start",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            args: toolCall.arguments,
        });

        let result: ToolExecutionResult = {content: ""};
        let isError = false;
        let executed = false;
        let progressFailure: { cause: unknown } | undefined;

        try {
            options.signal?.throwIfAborted();
            const tool = tools.find((item) => item.name === toolCall.name);
            if (!tool) throw new Error("找不到工具：" + toolCall.name);

            const args = validateToolArguments(tool, toolCall.arguments);
            const decision = await options.beforeToolCall?.(toolCall, options.signal);
            options.signal?.throwIfAborted();

            if (decision?.block) {
                result = {
                    content: "工具调用被拒绝：" + (decision.reason ?? "策略拒绝执行"),
                    terminate: decision.terminate,
                };
                isError = true;
            } else {
                executed = true;
                result = await tool.execute(args, options.signal, async (partialResult) => {
                    options.signal?.throwIfAborted();
                    try {
                        await options.emit?.({
                            type: "tool_execution_update",
                            toolCallId: toolCall.id,
                            toolName: toolCall.name,
                            partialResult,
                        });
                    } catch (error) {
                        progressFailure = {cause: error};
                        throw error;
                    }
                });
                options.signal?.throwIfAborted();
            }
        } catch (error) {
            result = {
                content: options.signal?.aborted
                    ? "工具调用已取消；已发生的文件修改不会自动撤销"
                    : "工具执行失败: " + (error instanceof Error ? error.message : String(error)),
            };
            isError = true;
        }

        // 即使 Tool 自己捕获了 onUpdate 异常，也不能隐藏事件系统故障。
        if (progressFailure) throw progressFailure.cause;

        // 只对真正执行过的工具做后处理。取消时跳过，避免取消后仍做额外工作。
        // 普通 execute 异常仍进入 after，允许脱敏或转换错误文案。
        if (executed && !options.signal?.aborted) {
            try {
                const override = await options.afterToolCall?.(
                    {toolCall, result, isError},
                    options.signal,
                );
                result = override?.result ?? result;
                isError = override?.isError ?? isError;
            } catch (error) {
                result = {
                    content: "工具执行失败: " +
                        (error instanceof Error ? error.message : String(error)),
                };
                isError = true;
            }
        }

        context.state = isError ? "error" : "done";
        context.finishedAt = Date.now();
        if (isError) context.error = result.content;
        else context.output = result.content;
        contexts.push(context);
        outcomes.push(result);

        await options.emit?.({
            type: "tool_execution_end",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            result,
            isError,
        });

        // 明确选字段：terminate 是本次运行控制信息，不是模型历史。
        results.push({
            role: "toolResult",
            toolCallId: toolCall.id,
            content: result.content,
            isError,
            details: result.details,
        });
    }

    return {
        contexts,
        results,
        allTerminated: outcomes.length > 0 &&
            outcomes.every((result) => result.terminate === true),
    };


}
