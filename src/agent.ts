import type {
    AgentMessage,
    BeforeToolCall,
    LlmClient,
    Tool,
    UserMessage,
} from "./types.ts";
import type {ConvertToLlm, TransformContext} from "./context.ts";
import {createAgentState, type AgentState} from "./agent-state.ts";
import {
    AgentEventBus,
    type AgentEvent,
    type AgentEventListener,
} from "./agent-events.ts";
import {
    runAgentLoop,
    type AgentLoopConfig,
    type AgentRunResult,
} from "./agent-loop.ts";
import {MessageQueue} from "./message-queue.ts";
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
    shouldStopAfterTurn?: AgentLoopConfig["shouldStopAfterTurn"];
};

class Agent {
    private readonly llm: LlmClient;
    private readonly maxTurns: number;
    private readonly beforeToolCall?: BeforeToolCall;
    private readonly sessionStore: SessionStore;
    private readonly transformContext?: TransformContext;
    private readonly convertToLlm?: ConvertToLlm;
    private readonly shouldStopAfterTurn?: AgentLoopConfig["shouldStopAfterTurn"];
    private readonly events = new AgentEventBus();
    private readonly _state: AgentState;
    private readonly steeringQueue = new MessageQueue();
    private readonly followUpQueue = new MessageQueue();

    private activeRun?: Promise<AgentRunResult>;
    private idlePromise: Promise<void> = Promise.resolve();
    private abortController?: AbortController;

    constructor(options: AgentOptions) {
        this.llm = options.llm;
        this.sessionStore = options.sessionStore;
        this.beforeToolCall = options.beforeToolCall;
        this.maxTurns = options.maxTurns ?? 10;
        if (!Number.isInteger(this.maxTurns) || this.maxTurns < 1) {
            throw new Error("maxTurns 必须是正整数");
        }
        this.transformContext = options.transformContext;
        this.convertToLlm = options.convertToLlm;
        this.shouldStopAfterTurn = options.shouldStopAfterTurn;
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

    /** 本任务开始返回 RunResult；全部历史请从 state.messages 读取。 */
    prompt(text: string): Promise<AgentRunResult> {
        return this.startRun([{role: "user", content: text}]);
    }

    /** 当前 Turn 完成后优先消费；不会抢占正在执行的单个工具。 */
    steer(message: UserMessage): void {
        this.steeringQueue.enqueue(message);
    }

    /** 当前任务自然结束后消费。 */
    followUp(message: UserMessage): void {
        this.followUpQueue.enqueue(message);
    }

    abort(): void {
        this.abortController?.abort();
    }

    /** 只等运行与清理结束，不重新抛出 prompt 的错误。 */
    async waitForIdle(): Promise<void> {
        await this.idlePromise;
    }

    /** 从已有 user/toolResult 继续；assistant 结尾必须有待处理队列。 */
    continue(): Promise<AgentRunResult> {
        if (this.activeRun) {
            return Promise.reject(new Error("Agent is already running"));
        }
        const last = this._state.messages.at(-1);
        if (!last) return Promise.reject(new Error("没有可继续的消息"));

        if (last.role === "assistant") {
            const steering = this.steeringQueue.drain();
            if (steering.length > 0) return this.startRun(steering);
            const followUps = this.followUpQueue.drain();
            if (followUps.length > 0) return this.startRun(followUps);
            return Promise.reject(new Error("不能从 assistant 消息直接继续"));
        }
        return this.startRun([]);
    }

    /**
     * 只清理当前 Agent 的内存，不删除 JSONL。
     * 新建持久化对话仍应使用 SessionManager.create() + 新 Agent。
     */
    reset(): void {
        if (this.activeRun) throw new Error("Agent 正在运行，不能 reset");
        this._state.messages = [];
        this._state.isRunning = false;
        this._state.streamingMessage = undefined;
        this._state.pendingToolCalls = new Set<string>();
        this._state.errorMessage = undefined;
        this.steeringQueue.clear();
        this.followUpQueue.clear();
    }

    private startRun(initialMessages: AgentMessage[]): Promise<AgentRunResult> {
        if (this.activeRun) {
            return Promise.reject(new Error("Agent is already running"));
        }

        const controller = new AbortController();
        this.abortController = controller;
        // 同步置位，prompt 返回后立即查询状态也能看到正在运行。
        this._state.isRunning = true;
        this._state.errorMessage = undefined;

        // 在微任务中开始 Loop，保证发布 agent_start 前运行锁已经建立。
        const run = Promise.resolve()
            .then(() => runAgentLoop(initialMessages, this._state, {
                llm: this.llm,
                maxTurns: this.maxTurns,
                beforeToolCall: this.beforeToolCall,
                transformContext: this.transformContext,
                convertToLlm: this.convertToLlm,
                shouldStopAfterTurn: this.shouldStopAfterTurn,
                signal: controller.signal,
                pollSteering: () => this.steeringQueue.drain(),
                pollFollowUp: () => this.followUpQueue.drain(),
                emit: (event) => this.handleEvent(event),
            }))
            .catch((error: unknown) => {
                this._state.errorMessage = error instanceof Error
                    ? error.message
                    : String(error);
                throw error;
            })
            .finally(() => {
                // 先清理再让返回给调用方的 Promise 完成。
                this.activeRun = undefined;
                this.abortController = undefined;
                this._state.isRunning = false;
                this._state.streamingMessage = undefined;
                this._state.pendingToolCalls = new Set<string>();
            });

        this.activeRun = run;
        // 两个分支都 resolve；不需要手动维护 resolveIdle 字段。
        this.idlePromise = run.then(() => undefined, () => undefined);
        return run;
    }

    private async handleEvent(event: AgentEvent): Promise<void> {
        this.applyEvent(event);
        if (event.type === "message_end") {
            await this.sessionStore.appendMessage(event.message);
        }
        await this.events.emit(event);
    }

    private applyEvent(event: AgentEvent): void {
        if (event.type === "agent_start") {
            this._state.isRunning = true;
            this._state.errorMessage = undefined;
        } else if (
            event.type === "message_start" &&
            event.message.role === "assistant"
        ) {
            this._state.streamingMessage = event.message;
        } else if (event.type === "message_update") {
            this._state.streamingMessage = event.message;
        } else if (
            event.type === "message_end" &&
            event.message.role === "assistant"
        ) {
            this._state.streamingMessage = undefined;
        } else if (event.type === "tool_execution_start") {
            this._state.pendingToolCalls = new Set([
                ...this._state.pendingToolCalls,
                event.toolCallId,
            ]);
        } else if (event.type === "tool_execution_end") {
            const pending = new Set(this._state.pendingToolCalls);
            pending.delete(event.toolCallId);
            this._state.pendingToolCalls = pending;
        } else if (event.type === "agent_end") {
            this._state.isRunning = false;
            this._state.streamingMessage = undefined;
            this._state.pendingToolCalls = new Set<string>();
        }
    }
}

export default Agent;