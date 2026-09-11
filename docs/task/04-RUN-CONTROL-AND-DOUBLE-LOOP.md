# Task 4：运行控制与双层 Loop 执行文档

## 目标与当前问题

Task 3 已经能完成“用户消息 → 模型 → 工具 → 模型”的单次运行。Task 4 增加运行互斥、取消、等待、继续，以及 steer/followUp 队列。

本文件按当前 agent-ts 的代码编写。只实施本任务，不提前实现 Task 5 的工具取消、afterToolCall 和 terminate。

你当前的 agent-loop.ts 同时保留了新 do/while 草稿和旧 for 循环。第 3 节必须整体替换该文件，不能把新循环追加在旧循环后面，否则用户消息会重复追加，而且局部函数仍未定义。

## 1. 文件清单与实施顺序

| 文件 | 操作 | 具体改动 |
|---|---|---|
| src/types.ts | 替换一个类型 | LlmRequestOptions 增加 signal |
| src/message-queue.ts | 新建或整体替换 | 两种队列共用的消息容器 |
| src/agent-loop.ts | 整体替换 | 完整局部函数、双层循环、取消与统一结束出口 |
| src/agent.ts | 整体替换 | 完整字段、构造函数、公开方法、handleEvent、applyEvent |
| src/real-llm.ts | 两处插入 | chat 和 chatStream 的 fetch 都传 signal |
| src/fake-llm.ts | 不需要修改 | Loop 自己在回调中检查 signal；取消等待使用专用测试 LLM |
| src/main.ts | 不需要修改 | 仍 await runAgentPrompt；交互控制命令在 Task 7 |
| src/execute-tools.ts、src/tools/ | 不需要修改 | 本任务不实现工具内部取消 |
| test/agent.test.ts | 修改五个测试调用点 | prompt 返回值从消息数组改成 AgentRunResult |
| test/message-queue.test.ts | 新建 | 验证 drain/clear 和复制行为 |
| test/agent-control.test.ts | 新建 | 运行控制、队列优先级、恢复、异常和收尾 |
| package.json | 替换 test 脚本 | 纳入新增测试和此前遗漏的 context.test.ts |

推荐：先创建第 7、8 节的测试，运行后观察当前代码失败，再依次实施第 2～6 节，最后执行第 9 节验证。

所有代码块均为 TypeScript；文件级“整体替换”包含 import，不需要猜测额外导入。Markdown 围栏不是代码，不要把 ts 一起粘贴到文件。

## 2. 修改 types.ts，新增 message-queue.ts

### 2.1 types.ts：只替换 LlmRequestOptions

其他消息、工具类型保持当前内容：

~~~ts
export type LlmRequestOptions = {
    systemPrompt?: string;
    signal?: AbortSignal;
};
~~~

你如果已经加了 signal，不要重复添加。

### 2.2 message-queue.ts：完整文件

~~~ts
import type {UserMessage} from "./types.ts";

/** 队列只负责保存和取出消息，不决定什么时候调用模型。 */
export class MessageQueue {
    private readonly messages: UserMessage[] = [];

    enqueue(message: UserMessage): void {
        this.messages.push(structuredClone(message));
    }

    /** 一次取出全部排队消息，同时清空队列。 */
    drain(): UserMessage[] {
        return this.messages.splice(0);
    }

    clear(): void {
        this.messages.length = 0;
    }

    get size(): number {
        return this.messages.length;
    }
}
~~~

入队时复制消息，避免调用方随后修改原对象。drain 返回的是已经移出队列的对象，不需要再复制一次。

## 3. agent-loop.ts：整体替换

下面包含原文档缺失的 appendAndEmitMessages、runTurn 和全部退出分支。

~~~ts
import type {AgentEventListener, AgentStopReason} from "./agent-events.ts";
import type {ConvertToLlm, TransformContext} from "./context.ts";
import {
    defaultConvertToLlm,
    identityTransformContext,
    prepareLlmContext,
} from "./context.ts";
import {executeTools} from "./execute-tools.ts";
import type {
    AgentMessage,
    AssistantMessage,
    BeforeToolCall,
    LlmClient,
    Tool,
    ToolResultMessage,
    UserMessage,
} from "./types.ts";

export type AgentContext = {
    systemPrompt: string;
    messages: AgentMessage[];
    tools: Tool[];
};

export type AgentRunResult = {
    newMessages: AgentMessage[];
    finalMessage?: AssistantMessage;
    reason: AgentStopReason;
};

export type AgentLoopConfig = {
    llm: LlmClient;
    maxTurns: number;
    emit: AgentEventListener;
    beforeToolCall?: BeforeToolCall;
    transformContext?: TransformContext;
    convertToLlm?: ConvertToLlm;
    signal?: AbortSignal;
    pollSteering?: () => UserMessage[];
    pollFollowUp?: () => UserMessage[];
    shouldStopAfterTurn?: (
        input: {
            message: AssistantMessage;
            toolResults: ToolResultMessage[];
            context: AgentContext;
            newMessages: AgentMessage[];
        },
        signal?: AbortSignal,
    ) => boolean | Promise<boolean>;
};

export async function runAgentLoop(
    initialMessages: AgentMessage[],
    context: AgentContext,
    config: AgentLoopConfig,
): Promise<AgentRunResult> {
    const newMessages: AgentMessage[] = [];
    const emit = config.emit;
    let finalMessage: AssistantMessage | undefined;
    let agentEnded = false;
    let turn = 0;

    /** 所有分支共用这个出口，保证不重复发布结束事件。 */
    async function emitAgentEnd(reason: AgentStopReason): Promise<void> {
        if (agentEnded) return;
        agentEnded = true;
        await emit({type: "agent_end", reason, newMessages});
    }

    async function finish(reason: AgentStopReason): Promise<AgentRunResult> {
        await emitAgentEnd(reason);
        return {newMessages, finalMessage, reason};
    }

    /** 完整的 user/toolResult 消息统一按此顺序追加并通知保存。 */
    async function appendAndEmitMessages(messages: AgentMessage[]): Promise<void> {
        for (const message of messages) {
            await emit({type: "message_start", message});
            context.messages.push(message);
            newMessages.push(message);
            await emit({type: "message_end", message});
        }
    }

    /** 一轮 = 请求一次模型 + 执行其返回的整批工具 + 发布 turn_end。 */
    async function runTurn(): Promise<{
        reply: AssistantMessage;
        toolResults: ToolResultMessage[];
    }> {
        await emit({type: "turn_start", turn});
        config.signal?.throwIfAborted();

        const llmMessages = await prepareLlmContext(
            context.messages,
            config.transformContext ?? identityTransformContext,
            config.convertToLlm ?? defaultConvertToLlm,
            config.signal,
        );
        config.signal?.throwIfAborted();

        let assistantWasAdded = false;
        const reply = await config.llm.chatStream(
            llmMessages,
            context.tools,
            async (event) => {
                config.signal?.throwIfAborted();

                if (event.type === "start") {
                    await emit({type: "message_start", message: event.partial});
                } else if (event.type === "text_delta") {
                    await emit({
                        type: "message_update",
                        message: event.partial,
                        update: {type: "text_delta", delta: event.delta},
                    });
                } else if (event.type === "toolcall_delta") {
                    await emit({
                        type: "message_update",
                        message: event.partial,
                        update: {type: "toolcall_delta"},
                    });
                } else if (event.type === "done") {
                    context.messages.push(event.message);
                    newMessages.push(event.message);
                    assistantWasAdded = true;
                    await emit({type: "message_end", message: event.message});
                }
            },
            {
                systemPrompt: context.systemPrompt,
                signal: config.signal,
            },
        );

        // 保留 Task 3 的兼容路径：某个 LLM 只返回结果而未发布 done 时仍追加一次。
        if (!assistantWasAdded) {
            config.signal?.throwIfAborted();
            context.messages.push(reply);
            newMessages.push(reply);
            await emit({type: "message_end", message: reply});
        }
        finalMessage = reply;

        // Task 4 的工具尚未接收 signal。
        // assistant 工具调用已入历史后，完成整批工具结果，再在 Turn 边界响应取消。
        const {results} = await executeTools(context.tools, reply, {
            beforeToolCall: config.beforeToolCall,
            emit,
        });

        await appendAndEmitMessages(results);
        await emit({
            type: "turn_end",
            turn,
            message: reply,
            toolResults: results,
        });
        return {reply, toolResults: results};
    }

    try {
        await emit({type: "agent_start"});
        config.signal?.throwIfAborted();
        if (!Number.isInteger(config.maxTurns) || config.maxTurns < 1) {
            throw new Error("maxTurns 必须是正整数");
        }

        let pendingMessages = [...initialMessages];

        // 外层负责初始输入，以及当前任务完成后的 followUp。
        // 必须 do/while：continue() 传 [] 时也需要执行第一次模型请求。
        do {
            config.signal?.throwIfAborted();
            await appendAndEmitMessages(pendingMessages);
            pendingMessages = [];

            // 内层负责工具触发的后续请求，以及优先插入的 steer。
            while (true) {
                config.signal?.throwIfAborted();
                if (turn >= config.maxTurns) return await finish("max_turns");
                turn++;

                const {reply, toolResults} = await runTurn();
                config.signal?.throwIfAborted();

                const shouldStop = await config.shouldStopAfterTurn?.({
                    message: reply,
                    toolResults,
                    context,
                    newMessages,
                }, config.signal);
                config.signal?.throwIfAborted();
                if (shouldStop) return await finish("terminated");

                // 用完预算且仍需要继续时，不能取走队列消息却不处理。
                if (turn >= config.maxTurns) {
                    // 无工具且没有队列时，第 N 轮直接回答仍属于正常完成。
                    // 是否有队列由下面轮询确定；轮询得到的消息会先记录再结束。
                    if (toolResults.length > 0) return await finish("max_turns");
                }

                const steering = config.pollSteering?.() ?? [];
                if (steering.length > 0) {
                    await appendAndEmitMessages(steering);
                    continue;
                }

                if (toolResults.length > 0) continue;
                break;
            }

            pendingMessages = config.pollFollowUp?.() ?? [];
        } while (pendingMessages.length > 0);

        return await finish("completed");
    } catch (error) {
        // 已尝试发布 agent_end 后，监听器异常仍向上传播，不能伪装成取消成功。
        if (agentEnded) throw error;
        if (config.signal?.aborted) return await finish("aborted");
        await emitAgentEnd("error");
        throw error;
    }
}
~~~

### 3.1 为什么旧循环要整个删除

新 runTurn 包含旧 for 循环里的模型请求、工具执行和 turn_end。外层与内层循环只负责决定“是否还要再执行一次 runTurn”。

初始消息只在 appendAndEmitMessages(pendingMessages) 中追加。不要保留旧的 initialMessages for 循环，否则同一 user 会重复进入 State 和 JSONL。

### 3.2 轮数的准确含义

maxTurns 计算一次 Run 内实际发出的模型请求次数，工具数量不计入；steer 和 followUp 不重置计数。

第 10 轮直接回答可以 completed；第 10 轮还返回工具调用则保存工具结果后 max_turns。此时可以从最后的 toolResult 调用 continue()，开始一个新的 Run 和新的轮数预算。

如果最后一轮直接回答后才取到排队输入，该输入会先保存为 user，下一轮预算检查返回 max_turns；它不会丢失，可以 continue()。这是学习版明确选择的边界行为。

### 3.3 取消的边界

- HTTP 连接或 SSE 读取中：fetch 收到 signal 后可以中止。
- 自定义 transformContext/shouldStopAfterTurn：传入 signal，但实现必须主动配合才能及时退出。
- 已开始的工具批次：Task 4 等待批次完成并保存结果后退出，不承诺立即停止文件修改。工具内取消留给 Task 5。
- 已写入文件的内容不会因 abort 自动撤销。

## 4. agent.ts：整体替换

包括之前缺失的 handleEvent()。Task 6 前仍在该方法内保存完整消息。

~~~ts
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
~~~

注意：

1. 不再需要旧文档的 resolveIdle 字段。idlePromise 从包含 finally 清理的 run 派生，成功和失败都正常完成。
2. 队列中尚未消费的消息在 abort/error 后保留，可通过 continue 消费。reset 会清空队列。
3. 不要在同一 Agent 的事件监听器中 await agent.waitForIdle()；Loop 正在等待监听器，双方等待会死锁。
4. 取消后未完成的 assistant partial 不保存；已经发布 message_end 的完整消息继续保留。
5. Agent.state.messages 是全部历史；RunResult.newMessages 仅包含本次新增。

## 5. real-llm.ts：只修改两处 fetch 配置

搜索两个 fetch 调用，分别位于 chat() 和 chatStream()。在 method 后加入同一行：

~~~ts
signal: options?.signal,
~~~

两处请求的开头都应是：

~~~ts
const response = await fetch(baseUrl + "/chat/completions", {
    method: "POST",
    signal: options?.signal,
    headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json",
    },
    // 此处保留各自原有的 body 属性；不要删除或共用两个方法的请求体。
});
~~~

上面只用于定位插入位置，不是完整 fetch 替换块。实际操作就是各插入一行 signal，其余原代码全部保留。

fetch 的 signal 同时作用于建立连接和后续响应体读取。不要在 RealLlmClient 把取消异常吞掉，交给 Loop 根据 signal.aborted 转换成 reason: "aborted"。

## 6. 旧调用点怎么改

### 6.1 main.ts 与 cli-agent-runner.ts 不改

当前 runAgentPrompt 只 await agent.prompt(text)，不读取返回数组，所以新返回类型不会破坏它。

本任务结束后，CLI 仍等待一次 Prompt 完成才读下一行；暂时不能在里面输入 /abort。运行控制先由测试与代码调用验证，CLI 的并发输入留到 Task 7。

### 6.2 test/agent.test.ts 的四处 messages 赋值

将每个这样的语句：

~~~ts
const messages = await agent.prompt("你好");
~~~

替换成：

~~~ts
const result = await agent.prompt("你好");
assert.equal(result.reason, "completed");
const messages = agent.state.messages;
~~~

文件中四个分别传入“你好”“调用 echo”“执行一个失败工具”“调用被禁止的工具”的调用点，都按上面三行替换，并保留各自原来的输入字符串。

第五个“连续调用 prompt”测试只是 await 两次，不接返回数组，所以不需要改。

new Agent({...}) 的对象构造方式保持不变。

### 6.3 普通业务调用示例

~~~ts
const result = await agent.prompt("读取 Readme.md");
console.log(result.reason);
console.log(result.finalMessage?.content);
console.log(result.newMessages);   // 仅本次
console.log(agent.state.messages); // 全部会话历史
~~~

运行中调用：

~~~ts
const run = agent.prompt("分析项目");
agent.steer({role: "user", content: "只读文件，不要修改"});
agent.followUp({role: "user", content: "最后给一段总结"});
const result = await run;
~~~

取消和等待：

~~~ts
const run = agent.prompt("分析项目");
agent.abort();
const result = await run; // 正常取消时 reason === "aborted"
await agent.waitForIdle();
~~~

## 7. 新建 test/message-queue.test.ts

~~~ts
import assert from "node:assert/strict";
import test from "node:test";
import {MessageQueue} from "../src/message-queue.ts";

test("队列复制输入，drain 按顺序返回并清空", () => {
    const queue = new MessageQueue();
    const first = {role: "user" as const, content: "one"};
    queue.enqueue(first);
    first.content = "被外部修改";
    queue.enqueue({role: "user", content: "two"});

    assert.equal(queue.size, 2);
    assert.deepEqual(queue.drain(), [
        {role: "user", content: "one"},
        {role: "user", content: "two"},
    ]);
    assert.equal(queue.size, 0);
    assert.deepEqual(queue.drain(), []);
});

test("clear 删除待处理消息", () => {
    const queue = new MessageQueue();
    queue.enqueue({role: "user", content: "one"});
    queue.clear();
    assert.deepEqual(queue.drain(), []);
});
~~~

## 8. 新建 test/agent-control.test.ts

这份文件不访问真实模型，不需要 API Key。BlockingLlm 只在测试中存在：先发布 partial，再等待取消，验证 signal 确实经过 Agent → Loop → LLM。

~~~ts
import assert from "node:assert/strict";
import test from "node:test";
import Agent from "../src/agent.ts";
import type {AgentEvent} from "../src/agent-events.ts";
import {FakeLlmClient} from "../src/fake-llm.ts";
import {MemorySessionStore} from "../src/session/memory-session-store.ts";
import type {
    AgentMessage,
    AssistantMessage,
    LlmClient,
    LlmRequestOptions,
    LlmStreamListener,
    Tool,
} from "../src/types.ts";

function createStore(): MemorySessionStore {
    return new MemorySessionStore({id: "test", createdAt: 0});
}

class BlockingLlm implements LlmClient {
    async chat(): Promise<AssistantMessage> {
        throw new Error("测试只允许调用 chatStream");
    }

    async chatStream(
        _messages: AgentMessage[],
        _tools: Tool[],
        onEvent: LlmStreamListener,
        options?: LlmRequestOptions,
    ): Promise<AssistantMessage> {
        const signal = options?.signal;
        if (!signal) throw new Error("没有收到 AbortSignal");

        await onEvent({
            type: "start",
            partial: {role: "assistant", content: ""},
        });
        await onEvent({
            type: "text_delta",
            delta: "partial",
            partial: {role: "assistant", content: "partial"},
        });

        await new Promise<void>((_resolve, reject) => {
            if (signal.aborted) {
                reject(signal.reason);
                return;
            }
            signal.addEventListener("abort", () => reject(signal.reason), {once: true});
        });
        throw new Error("此测试 LLM 只能通过取消结束");
    }
}

test("运行锁立即生效，取消后清理 partial，waitForIdle 等到收尾", async () => {
    const store = createStore();
    const agent = new Agent({llm: new BlockingLlm(), tools: [], sessionStore: store});
    const events: AgentEvent[] = [];
    let idleCompleted = false;
    agent.subscribe((event) => {
        events.push(structuredClone(event));
        if (event.type === "message_update") {
            assert.equal(agent.state.streamingMessage?.content, "partial");
            assert.equal(idleCompleted, false);
            agent.abort();
        }
    });

    const run = agent.prompt("开始");
    assert.equal(agent.state.isRunning, true);
    const idle = agent.waitForIdle().then(() => { idleCompleted = true; });
    await assert.rejects(agent.prompt("重复"), /already running/);
    const result = await run;
    await idle;

    assert.equal(result.reason, "aborted");
    assert.equal(agent.state.isRunning, false);
    assert.equal(agent.state.streamingMessage, undefined);
    assert.equal(agent.state.pendingToolCalls.size, 0);
    assert.equal(idleCompleted, true);
    assert.equal(events.filter((event) => event.type === "agent_end").length, 1);
    assert.deepEqual(await store.getMessages(), [{role: "user", content: "开始"}]);
});

test("失败后 waitForIdle 不抛错，并可 continue 恢复", async () => {
    const llm = new FakeLlmClient([{role: "assistant", content: "恢复成功"}]);
    let fail = true;
    const agent = new Agent({
        llm, tools: [], sessionStore: createStore(),
        transformContext: async (messages) => {
            if (fail) {
                fail = false;
                throw new Error("上下文处理失败");
            }
            return messages;
        },
    });
    await assert.rejects(agent.prompt("开始"), /上下文处理失败/);
    await agent.waitForIdle();
    assert.equal(agent.state.isRunning, false);
    assert.match(agent.state.errorMessage ?? "", /上下文处理失败/);

    const result = await agent.continue();
    assert.equal(result.finalMessage?.content, "恢复成功");
    assert.equal(agent.state.errorMessage, undefined);
    assert.deepEqual(llm.requests[0]?.messages, [{role: "user", content: "开始"}]);
});

test("steer 优先于工具后续请求，followUp 等当前任务结束", async () => {
    const llm = new FakeLlmClient([
        {
            role: "assistant", content: "",
            toolCalls: [{id: "c1", name: "echo", arguments: {}}],
        },
        {role: "assistant", content: "当前任务完成"},
        {role: "assistant", content: "总结完成"},
    ]);
    const tool: Tool = {
        name: "echo", description: "测试",
        parameters: {type: "object", properties: {}},
        async execute() { return {content: "工具结果"}; },
    };
    const agent = new Agent({llm, tools: [tool], sessionStore: createStore()});
    agent.subscribe((event) => {
        if (event.type === "turn_end" && event.turn === 1) {
            agent.followUp({role: "user", content: "最后总结"});
            agent.steer({role: "user", content: "改为只读"});
        }
    });
    const result = await agent.prompt("开始");
    assert.equal(result.reason, "completed");
    assert.equal(llm.requests.length, 3);
    assert.equal(llm.requests[1]?.messages.at(-1)?.content, "改为只读");
    assert.equal(llm.requests[2]?.messages.at(-1)?.content, "最后总结");
    assert.deepEqual(agent.state.messages.map((message) => message.role), [
        "user", "assistant", "toolResult", "user", "assistant", "user", "assistant",
    ]);
});

test("shouldStopAfterTurn 优先于待处理队列", async () => {
    const llm = new FakeLlmClient([{role: "assistant", content: "回答"}]);
    const agent = new Agent({
        llm, tools: [], sessionStore: createStore(),
        shouldStopAfterTurn: () => true,
    });
    agent.steer({role: "user", content: "新方向"});
    agent.followUp({role: "user", content: "后续"});
    const result = await agent.prompt("开始");
    assert.equal(result.reason, "terminated");
    assert.equal(llm.requests.length, 1);
    assert.deepEqual(agent.state.messages.map((message) => message.content), ["开始", "回答"]);
});

test("最后一轮直接回答属于 completed", async () => {
    const agent = new Agent({
        llm: new FakeLlmClient([{role: "assistant", content: "回答"}]),
        tools: [], sessionStore: createStore(), maxTurns: 1,
    });
    assert.equal((await agent.prompt("开始")).reason, "completed");
});

test("轮数耗尽后从 toolResult 继续，新的 Run 使用新的预算", async () => {
    const llm = new FakeLlmClient([
        {
            role: "assistant", content: "",
            toolCalls: [{id: "c1", name: "missing", arguments: {}}],
        },
        {role: "assistant", content: "解释工具错误"},
    ]);
    const agent = new Agent({llm, tools: [], sessionStore: createStore(), maxTurns: 1});
    const first = await agent.prompt("开始");
    assert.equal(first.reason, "max_turns");
    assert.equal(agent.state.messages.at(-1)?.role, "toolResult");
    const second = await agent.continue();
    assert.equal(second.reason, "completed");
    assert.equal(second.finalMessage?.content, "解释工具错误");
});

test("空历史和无队列的 assistant 不能 continue", async () => {
    const agent = new Agent({
        llm: new FakeLlmClient([{role: "assistant", content: "回答"}]),
        tools: [], sessionStore: createStore(),
    });
    await assert.rejects(agent.continue(), /没有可继续/);
    await agent.prompt("开始");
    await assert.rejects(agent.continue(), /assistant/);
});

for (const queue of ["steer", "followUp"] as const) {
    test("assistant 结尾可用 " + queue + " 队列继续", async () => {
        const llm = new FakeLlmClient([
            {role: "assistant", content: "第一次"},
            {role: "assistant", content: "第二次"},
        ]);
        const agent = new Agent({llm, tools: [], sessionStore: createStore()});
        await agent.prompt("开始");
        agent[queue]({role: "user", content: "继续要求"});
        const result = await agent.continue();
        assert.equal(result.reason, "completed");
        assert.equal(llm.requests[1]?.messages.at(-1)?.content, "继续要求");
    });
}

test("message_end 订阅者失败仍结束且只发布一次 agent_end", async () => {
    const agent = new Agent({
        llm: new FakeLlmClient([]), tools: [], sessionStore: createStore(),
    });
    let ends = 0;
    agent.subscribe((event) => {
        if (event.type === "message_end") throw new Error("监听器失败");
        if (event.type === "agent_end") ends++;
    });
    await assert.rejects(agent.prompt("开始"), /监听器失败/);
    await agent.waitForIdle();
    assert.equal(ends, 1);
    assert.equal(agent.state.isRunning, false);
});

test("reset 清空内存与队列，但不删除 Store 的历史", async () => {
    const store = createStore();
    const agent = new Agent({
        llm: new FakeLlmClient([{role: "assistant", content: "回答"}]),
        tools: [], sessionStore: store,
    });
    await agent.prompt("开始");
    agent.steer({role: "user", content: "队列"});
    agent.reset();
    assert.deepEqual(agent.state.messages, []);
    assert.equal((await store.getMessages()).length, 2);
    await assert.rejects(agent.continue(), /没有可继续/);
});
~~~

## 9. package.json、验证与断点

把 scripts.test 的值替换为以下完整命令，其他配置不变：

~~~json
"test": "tsx --test test/agent.test.ts test/agent-loop.test.ts test/agent-control.test.ts test/message-queue.test.ts test/context.test.ts test/memory-session-store.test.ts test/jsonl-session-store.test.ts test/session-manager.test.ts test/skills.test.ts test/real-llm.test.ts test/cli-agent-runner.test.ts test/agent-state.test.ts test/agent-events.test.ts"
~~~

实施完成后依次运行：

~~~powershell
npx tsx --test test/message-queue.test.ts test/agent-control.test.ts
npm run check
npm test
~~~

不要运行真实模型来代替测试；上面的测试不需要配置网络或密钥。

IDEA 建议断点：

| 位置 | 看什么 |
|---|---|
| Agent.startRun 的 this.activeRun = run | Promise 已保存，事件尚未开始 |
| runTurn 的 chatStream 调用 | signal 从 Agent 贯穿到模型请求 |
| Loop 的 pollSteering | drain 取出新指令，下一次请求包含它 |
| Loop 的 pollFollowUp | 只有当前任务自然结束后才到这里 |
| Loop 的 catch | signal.aborted 时返回 aborted；普通错误重新抛出 |
| Agent.startRun 的 finally | 锁、controller、partial、pending 最终都清理 |
| continue 的 last.role 判断 | user/toolResult 直接续跑；assistant 需排队消息 |

建议提交信息（自行验证后提交）：

~~~text
feat(agent): 增加运行控制与 steer/followUp 双层循环
~~~

## 10. 通俗说明：把新方法串起来

~~~text
prompt("分析项目")
→ startRun 同步建立运行锁
→ 创建 AbortController
→ Loop 外层保存初始 user
→ 内层 runTurn 请求模型并执行工具
→ 有 steer：追加新指令，继续内层
→ 没有 steer 但有工具结果：继续内层
→ 当前任务完成：退出内层
→ 有 followUp：进入下一次外层
→ agent_end
→ finally 清理
→ prompt 返回 RunResult；waitForIdle 也完成
~~~

调用 abort() 是把 signal.aborted 设为 true，并通知支持取消的操作。不是强杀 JavaScript，也不撤销已经完成的文件写入。

activeRun 是运行锁兼结果 Promise；idlePromise 是只等结束的 Promise。模型失败时，prompt 抛错供 CLI 显示，waitForIdle 仍正常返回，方便退出和清理。

steer/followUp 都是 user 消息，但消费时机不同。steer 在当前 Turn 后优先处理，followUp 等任务自然结束。它们都会在真正进入上下文时通过 message_end 保存到 Session。

Task 4 完成的是代码层控制能力。能在终端边运行边输入 /abort、/steer，要等 Task 7 改造 CLI 的输入循环。
