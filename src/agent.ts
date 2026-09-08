import type {
    AgentMessage,
    BeforeToolCall,
    LlmClient,
    Tool,
} from "./types.ts";
import type {ConvertToLlm, TransformContext} from "./context.ts";
import {
    createAgentState,
    type AgentState,
} from "./agent-state.ts";
import {
    AgentEventBus,
    type AgentEvent,
    type AgentEventListener,
} from "./agent-events.ts";
import {runAgentLoop} from "./agent-loop.ts";
import type {SessionStore} from "./session/session-store.ts";

export type AgentOptions = {
    llm: LlmClient;
    tools: Tool[];
    sessionStore: SessionStore;
    beforeToolCall?: BeforeToolCall;
    systemPrompt?: string;
    initialMessages?: AgentMessage[];
    maxTurns?: number;
    transformContext?: TransformContext;
    convertToLlm?: ConvertToLlm;
};


class Agent {

    private readonly llm: LlmClient;
    private readonly maxTurns: number;
    private readonly beforeToolCall?: BeforeToolCall;
    private readonly sessionStore: SessionStore;
    private readonly transformContext?: TransformContext;
    private readonly convertToLlm?: ConvertToLlm;
    private readonly events = new AgentEventBus();
    private readonly _state: AgentState;

    constructor(options: AgentOptions) {
        this.llm = options.llm;
        this.sessionStore = options.sessionStore;
        this.beforeToolCall = options.beforeToolCall;
        this.maxTurns = options.maxTurns ?? 10;
        this.transformContext = options.transformContext;
        this.convertToLlm = options.convertToLlm;
        this._state = createAgentState({
            systemPrompt: options.systemPrompt ?? "",
            tools: options.tools,
            messages: options.initialMessages ?? [],
        });
    }



    get state(): AgentState {
        return this._state;
    }

    subscribe(listener: AgentEventListener): () => void {
        return this.events.subscribe(listener);
    }

    async prompt(text: string): Promise<AgentMessage[]> {
        const result = await runAgentLoop(
            [{role: "user", content: text}],
            this._state,
            {
                llm: this.llm,
                maxTurns: this.maxTurns,
                beforeToolCall: this.beforeToolCall,
                transformContext: this.transformContext,
                convertToLlm: this.convertToLlm,
                emit: async (event) => {
                    this.applyEvent(event);
                    // Task 6 会把 Session 保存提取成独立订阅器；在此之前保持现有持久化行为。
                    if (event.type === "message_end") {
                        await this.sessionStore.appendMessage(event.message);
                    }
                    await this.events.emit(event);
                },
            },
        );

        return [...this._state.messages];
    }

    private applyEvent(event: AgentEvent): void {
        if (event.type === "agent_start") {
            this._state.isRunning = true;
            this._state.errorMessage = undefined;
            return;
        }

        if (
            event.type === "message_start" &&
            event.message.role === "assistant"
        ) {
            this._state.streamingMessage = event.message;
            return;
        }

        if (event.type === "message_update") {
            this._state.streamingMessage = event.message;
            return;
        }

        if (
            event.type === "message_end" &&
            event.message.role === "assistant"
        ) {
            this._state.streamingMessage = undefined;
            return;
        }

        if (event.type === "tool_execution_start") {
            this._state.pendingToolCalls = new Set([
                ...this._state.pendingToolCalls,
                event.toolCallId,
            ]);
            return;
        }

        if (event.type === "tool_execution_end") {
            const pending = new Set(this._state.pendingToolCalls);
            pending.delete(event.toolCallId);
            this._state.pendingToolCalls = pending;
            return;
        }

        if (event.type === "agent_end") {
            this._state.isRunning = false;
            this._state.streamingMessage = undefined;
            this._state.pendingToolCalls = new Set<string>();
        }
    }

}

export default Agent
