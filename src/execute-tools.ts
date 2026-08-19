import {AssistantMessage, Tool, ToolResultMessage} from "./types.ts";


export async function executeTools(
    tools: Tool[],
    message: AssistantMessage,
): Promise<ToolResultMessage[]> {
    const results: ToolResultMessage[] = [];

    for (const toolCall of message.toolCalls ?? []) {
        const tool = tools.find((t) => t.name === toolCall.name);

        let content: string;

        if (!tool) {
            content = `找不到工具：${toolCall.name}`;
        } else {
            try {
                content = await tool.execute(toolCall.arguments);
            } catch (error) {
                content = error instanceof Error ? `工具执行失败: ${error.message}` : String(error);
            }
        }

        results.push({
            role: "toolResult",
            toolCallId: toolCall.id,
            content,
        });

    }

    return results;
}