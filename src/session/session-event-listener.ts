import type {AgentEventListener} from "../agent-events.ts";
import type {SessionStore} from "./session-store.ts";

/** 只订阅完整消息，忽略 partial、工具进度和运行状态事件。 */
export function createSessionEventListener(
    store: SessionStore,
): AgentEventListener {
    return async (event) => {
        if (event.type === "message_end") {
            await store.appendMessage(event.message);
        }
    };
}