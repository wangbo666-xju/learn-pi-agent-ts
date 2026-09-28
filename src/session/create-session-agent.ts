import Agent, {type AgentOptions} from "../agent.ts";
import {createSessionEventListener} from "./session-event-listener.ts";
import type {SessionStore} from "./session-store.ts";
import {buildAgentContext} from "./build-agent-context.ts";

/**
 * 装配层：读取全部 Entry，构建“最新摘要 + 保留消息”上下文，再接上保存监听器。
 * 只允许 Store 提供 initialMessages，避免两个历史来源互相覆盖。
 */
export async function createSessionAgent(
    store: SessionStore,
    options: Omit<AgentOptions, "initialMessages">,
): Promise<Agent> {
    const initialMessages = buildAgentContext(await store.getEntries());
    const agent = new Agent({...options, initialMessages});
    agent.subscribe(createSessionEventListener(store));
    return agent;
}
