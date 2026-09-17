import Agent, {type AgentOptions} from "../../src/agent.ts";
import {createSessionEventListener} from "../../src/session/session-event-listener.ts";
import type {SessionStore} from "../../src/session/session-store.ts";

/** 仅用于旧测试的装配，不是生产 Agent 的存储接口。 */
export function createTestAgent(
    options: AgentOptions & {sessionStore: SessionStore},
): Agent {
    const {sessionStore, ...agentOptions} = options;
    const agent = new Agent(agentOptions);
    agent.subscribe(createSessionEventListener(sessionStore));
    return agent;
}