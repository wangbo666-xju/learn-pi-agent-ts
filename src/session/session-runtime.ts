import type {MemoryWorkspace} from "../memory/memory-workspace.ts";
import type {MemoryToolSet} from "../memory/memory-tools.ts";
import {buildMemoryContext} from "../memory/memory-context.ts";
import type Agent from "../agent.ts";
import type {AgentOptions} from "../agent.ts";
import type {AgentRunResult} from "../agent-loop.ts";
import type {AgentEventListener} from "../agent-events.ts";
import type {AgentMessage, LlmClient, UserMessage} from "../types.ts";
import {compactSession, prepareCompaction} from "../compaction.ts";
import {ContextOverflowError} from "../llm-usage.ts";
import {estimateContextTokens, validateAutoCompact, type AutoCompactOptions} from "../context-budget.ts";
import {createSessionAgent} from "./create-session-agent.ts";
import type {SessionStore} from "./session-store.ts";

export type CompactionEvent = {
    type: "auto_compaction_start" | "auto_compaction_end";
    reason: "threshold" | "overflow";
    error?: string;
};

export type SessionRuntimeOptions = Omit<AgentOptions, "initialMessages"> & {
    /** 可选的项目记忆依赖；不配置时保持原来的行为。 */
    memory?: {
        workspace: MemoryWorkspace;
        tools: MemoryToolSet;
        onWarning?: (message: string) => void;
    };
    autoCompact?: AutoCompactOptions;
    onCompaction?: (event: CompactionEvent) => void;
};

/**
 * Session 协调器：Agent 只执行任务；这里负责执行前后整理历史与一次溢出恢复。
 * 整个 prompt（含摘要、重试）共用运行锁，不能在压缩期间插入另一个 prompt。
 */
export class SessionRuntime {
    private readonly agent: Agent;
    private readonly store: SessionStore;
    private readonly llm: LlmClient;
    private readonly limits?: AutoCompactOptions;
    private readonly onCompaction?: SessionRuntimeOptions["onCompaction"];
    private controller?: AbortController;
    private active?: Promise<unknown>;
    private idle: Promise<void> = Promise.resolve();
    private compacting = false;
    private readonly memory?: SessionRuntimeOptions["memory"];
    private readonly baseSystemPrompt: string;

    constructor(agent: Agent, store: SessionStore, options: SessionRuntimeOptions) {
        this.agent = agent;
        this.store = store;
        this.llm = options.llm;
        if (options.autoCompact) validateAutoCompact(options.autoCompact);
        this.limits = options.autoCompact ? {...options.autoCompact} : undefined;
        this.onCompaction = options.onCompaction;
        this.memory = options.memory;
        // 保存不含动态 Memory 的基础提示词，避免每次运行重复追加。
        this.baseSystemPrompt = options.systemPrompt ?? "";
    }

    get state() {
        return this.agent.state;
    }

    get isCompacting(): boolean {
        return this.compacting;
    }

    subscribe(listener: AgentEventListener): () => void {
        return this.agent.subscribe(listener);
    }

    steer(message: UserMessage): void {
        if (this.compacting) throw new Error("正在压缩，请等待完成后再加入指令");
        this.agent.steer(message);
    }

    followUp(message: UserMessage): void {
        if (this.compacting) throw new Error("正在压缩，请等待完成后再加入指令");
        this.agent.followUp(message);
    }

    abort(): void {
        this.controller?.abort();
        this.agent.abort();
    }

    async waitForIdle(): Promise<void> {
        await this.idle;
        await this.agent.waitForIdle();
    }

    prompt(text: string): Promise<AgentRunResult> {
        return this.exclusive((signal) => this.run(() => this.agent.prompt(text), signal));
    }

    continue(): Promise<AgentRunResult> {
        return this.exclusive((signal) => this.run(() => this.agent.continue(), signal));
    }

    /** 手动入口也走同一运行锁，防止摘要期间启动新任务。 */
    compact(signal?: AbortSignal): Promise<string> {
        return this.exclusive(async (ownSignal) => {
            this.compacting = true;
            try {
                return await compactSession(this.agent, this.store, this.llm,
                    signal ? AbortSignal.any([signal, ownSignal]) : ownSignal);
            } finally {
                this.compacting = false;
            }
        });
    }

    /** 同步建锁和取消控制器，立即 /abort 不会错过尚未开始的异步流程。 */
    private exclusive<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
        if (this.active || this.agent.state.isRunning) return Promise.reject(new Error("Session 正在运行或压缩"));
        const controller = new AbortController();
        this.controller = controller;
        const run = Promise.resolve().then(() => operation(controller.signal)).finally(() => {
            this.active = undefined;
            this.controller = undefined;
        });
        this.active = run;
        this.idle = run.then(() => undefined, () => undefined);
        return run;
    }

    private async run(start: () => Promise<AgentRunResult>, signal: AbortSignal): Promise<AgentRunResult> {
        const newMessages: AgentMessage[] = [];
        const unsubscribe = this.agent.subscribe((event) => {
            if (event.type === "message_end") newMessages.push(structuredClone(event.message));
        });
        let result: AgentRunResult | undefined;
        try {
            signal.throwIfAborted();
            await this.refreshMemoryContext(signal);
            signal.throwIfAborted();
            await this.checkThreshold(signal);
            signal.throwIfAborted();
            try {
                result = await start();
            } catch (error) {
                // 取消不能覆盖 Agent 已经传播出来的保存/监听器错误。
                if (signal.aborted) throw error;
                if (!this.limits || !(error instanceof ContextOverflowError)) throw error;
                // 已执行工具与 user 已落盘；continue 不重放 prompt，不重复执行旧工具。
                if (!await this.autoCompact("overflow", signal)) {
                    throw new Error("上下文溢出且没有可压缩的旧分组，请缩小输入或新建会话", {cause: error});
                }
                signal.throwIfAborted();
                result = await this.agent.continue(); // 仅重试一次；再次溢出直接交给调用者。
            }
            if (result.reason === "completed" && !signal.aborted) await this.checkThreshold(signal);
            return {...result, newMessages, reason: signal.aborted ? "aborted" : result.reason};
        } catch (error) {
            if (signal.aborted && (error === signal.reason || (error instanceof Error && error.name === "AbortError"))) {
                return {newMessages, finalMessage: result?.finalMessage, reason: "aborted"};
            }
            throw error;
        } finally {
            unsubscribe();
        }
    }

    /** 只做运行前加载；不生成记忆，不启动第二个 Agent。 */
    private async refreshMemoryContext(signal: AbortSignal): Promise<void> {
        if (!this.memory) return;
        this.memory.tools.clearReads();
        let index = "";
        let unavailable = false;
        try {
            index = await this.memory.workspace.readIndex(signal);
        } catch (error) {
            signal.throwIfAborted(); // 用户取消不能被降级成普通读取警告。
            unavailable = true;
            const message = error instanceof Error ? error.message : String(error);
            try {
                this.memory.onWarning?.("记忆索引加载失败：" + message);
            } catch { /* 展示失败不影响主任务。 */
            }
        }
        signal.throwIfAborted();
        this.agent.state.systemPrompt = [
            this.baseSystemPrompt,
            buildMemoryContext(this.memory.workspace.root, index, unavailable),
        ].filter(Boolean).join("\n\n");
    }

    private async checkThreshold(signal: AbortSignal): Promise<void> {
        if (!this.limits) return;
        const key = this.llm.getUsageContextKey?.(this.state.tools, {systemPrompt: this.state.systemPrompt});
        const tokens = estimateContextTokens(await this.store.getEntries(), key);
        signal.throwIfAborted();
        if (tokens === undefined || tokens <= this.limits.contextWindowTokens - this.limits.reserveTokens) return;
        // 阈值压缩属于维护：失败不抹掉已完成的回答，事件报告失败；溢出路径则必须成功才重试。
        try {
            await this.autoCompact("threshold", signal);
        } catch (error) {
            if (signal.aborted) throw error;
        }
    }

    private async autoCompact(reason: CompactionEvent["reason"], signal: AbortSignal): Promise<boolean> {
        this.compacting = true;
        let errorMessage: string | undefined;
        let started = false;
        try {
            signal.throwIfAborted();
            if (!prepareCompaction(await this.store.getEntries())) return false;
            started = true;
            this.onCompaction?.({type: "auto_compaction_start", reason});
            await compactSession(this.agent, this.store, this.llm, signal);
            return true;
        } catch (error) {
            errorMessage = signal.aborted ? "压缩已取消" : error instanceof Error ? error.message : String(error);
            throw error;
        } finally {
            this.compacting = false;
            if (started || errorMessage) this.onCompaction?.({
                type: "auto_compaction_end",
                reason,
                error: errorMessage
            });
        }
    }
}

/** 保留原 createSessionAgent 给不需要自动压缩的调用者使用。 */
export async function createSessionRuntime(store: SessionStore, options: SessionRuntimeOptions): Promise<SessionRuntime> {
    if (options.autoCompact) validateAutoCompact(options.autoCompact);
    const agent = await createSessionAgent(store, options);
    return new SessionRuntime(agent, store, options);
}