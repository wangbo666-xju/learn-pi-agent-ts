import Agent, {type AgentOptions} from "../agent.ts";
import {createSessionEventListener} from "./session-event-listener.ts";
import type {SessionStore} from "./session-store.ts";

/**
 * 装配层：先从 Store 恢复完整历史，再把新消息保存监听器接到 Agent。
 * 只允许 Store 提供 initialMessages，避免两个历史来源互相覆盖。
 */
export async function createSessionAgent(
    store: SessionStore,
    options: Omit<AgentOptions, "initialMessages">,
): Promise<Agent> {
    const initialMessages = await store.getMessages();
    const agent = new Agent({...options, initialMessages});
    agent.subscribe(createSessionEventListener(store));
    return agent;
}