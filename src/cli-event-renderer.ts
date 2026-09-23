import type {AgentEventListener} from "./agent-events.ts";

/** 只负责显示，不保存 Session、不修改 AgentState。 */
export function createCliEventRenderer(
    write: (text: string) => void,
): AgentEventListener {
    return (event) => {
        if (event.type === "message_update" && event.update.type === "text_delta") {
            write(event.update.delta);
        } else if (event.type === "message_end" && event.message.role === "assistant") {
            write("\n");
        } else if (event.type === "tool_execution_update") {
            write("\n工具进度：" + event.toolName + " " + event.partialResult.content + "\n");
        } else if (event.type === "tool_execution_end") {
            write("\n工具执行状态：" + event.toolName +
                ":" + (event.isError ? "error" : "done") + "\n");
        }
    };
}
