import {AssistantMessage, Tool, ToolResultMessage, ToolRunContext} from "./types.ts";


export async function executeTools(
    tools: Tool[],
    message: AssistantMessage,
): Promise<{ contexts: ToolRunContext[]; results: ToolResultMessage[] }> {
    const results: ToolResultMessage[] = [];
    const contexts: ToolRunContext[] = [];


    for (const toolCall of message.toolCalls ?? []) {

        const startedAt = Date.now();

        const tool = tools.find((t) => t.name === toolCall.name);

        const toolRun: ToolRunContext = {
            id: toolCall.id,
            name: toolCall.name,
            state: "running",
            startedAt,
            input: toolCall.arguments
        };


        let content: string;

        if (!tool) {
            toolRun.state = "error";
            content = `找不到工具：${toolCall.name}`;
        } else {
            try {
                const output = await tool.execute(toolCall.arguments);
                content = output;
                toolRun.state = "done";
                toolRun.output = output;

            } catch (error) {
                toolRun.state = "error";
                toolRun.error = error instanceof Error ? error.message : String(error);
                content = `工具执行失败: ${toolRun.error}`;
            }
        }
        toolRun.finishedAt = Date.now();
        contexts.push(toolRun);

        results.push({
            role: "toolResult",
            toolCallId: toolCall.id,
            content,
        });

    }

    return {contexts, results};
}