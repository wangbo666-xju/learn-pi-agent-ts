import type Agent from "./agent.ts";
import type {CliCommand} from "./cli-command.ts";

export type PromptableAgent = {
    prompt(text: string): Promise<unknown>;
};

/** 保留原单次 Prompt 调用入口，适合顺序执行脚本。 */
export async function runAgentPrompt(
    agent: PromptableAgent,
    text: string,
    onError: (message: string) => void,
): Promise<void> {
    try {
        await agent.prompt(text);
    } catch (error) {
        onError(error instanceof Error ? error.message : String(error));
    }
}

/** 每个 Session 对应一个 Runner，关闭后不再复用。 */
export function createCliRunner(
    agent: Agent,
    write: (text: string) => void,
    compact?: (signal: AbortSignal) => Promise<string>,
) {
    let activePrompt: Promise<void> | undefined;
    let activeCompaction: Promise<void> | undefined;
    let compactionController: AbortController | undefined;
    let closed = false;

    // 摘要请求不经过 Agent.prompt，因此必须由 Runner 统一互斥。
    function isBusy(): boolean {
        return Boolean(activePrompt || activeCompaction) || agent.state.isRunning;
    }

    /** /abort、Ctrl+C 和 close 共用入口，同时覆盖普通任务和摘要请求。 */
    function abort(): void {
        agent.abort();
        compactionController?.abort();
    }

    function startPrompt(text: string): void {
        if (closed) {
            write("当前会话控制器已关闭\n");
            return;
        }
        if (isBusy()) {
            write("当前正在运行或压缩，请等待完成或 /abort\n");
            return;
        }

        // 立即调用，使 Agent 的运行锁与 AbortController 同步建立。
        // 不要把 agent.prompt 本身延迟到下一个微任务，否则立即 /abort 会错过它。
        const run = agent.prompt(text);
        const observed = run
            .then((result) => {
                if (result.reason !== "completed") {
                    write("\n本次运行结束：" + result.reason + "\n");
                }
            })
            .catch((error: unknown) => {
                write("\n执行失败：" +
                    (error instanceof Error ? error.message : String(error)) + "\n");
            })
            .finally(() => {
                if (activePrompt === observed) activePrompt = undefined;
            });
        activePrompt = observed;
    }

    function startCompaction(): void {
        if (closed) {
            write("当前会话控制器已关闭\n");
            return;
        }
        if (isBusy()) {
            write("当前正在运行或压缩，请等待完成或 /abort\n");
            return;
        }
        if (!compact) {
            write("当前会话未配置压缩功能\n");
            return;
        }

        const operation = compact;
        const controller = new AbortController();
        compactionController = controller;
        // 同步登记 busy，异步执行；紧接着输入 /abort 或 /exit 也能取消。
        activeCompaction = Promise.resolve()
            .then(() => {
                controller.signal.throwIfAborted();
                return operation(controller.signal);
            })
            .then((message) => { write(message + "\n"); })
            .catch((error: unknown) => {
                write(controller.signal.aborted
                    ? "压缩已取消\n"
                    : "压缩失败：" + (error instanceof Error ? error.message : String(error)) + "\n");
            })
            .finally(() => {
                activeCompaction = undefined;
                compactionController = undefined;
            });
    }

    /**
     * true：本命令已经处理，main 不再路由。
     * false：交回 main 处理会话、Skill 或普通 Prompt。
     */
    function handleControl(command: CliCommand): boolean {
        if (command.type === "compact") {
            startCompaction();
            return true;
        }
        if (command.type === "status") {
            write(JSON.stringify({
                isRunning: agent.state.isRunning,
                isSettling: Boolean(activePrompt) && !agent.state.isRunning,
                isCompacting: Boolean(activeCompaction),
                pendingToolCalls: [...agent.state.pendingToolCalls],
                errorMessage: agent.state.errorMessage,
            }) + "\n");
            return true;
        }
        if (command.type === "abort") {
            abort();
            write("已请求取消；等待当前操作响应并完成收尾\n");
            return true;
        }
        if (command.type === "steer" || command.type === "followup") {
            if (activeCompaction) {
                write("正在压缩，不能加入指令；请等待完成或 /abort\n");
            } else if (!command.text) {
                write("用法：/" + command.type + " <要求>\n");
            } else if (!agent.state.isRunning) {
                write("当前没有运行中的任务，请直接输入要求\n");
            } else {
                const message = {role: "user" as const, content: command.text};
                if (command.type === "steer") agent.steer(message);
                else agent.followUp(message);
                write("已加入 " + command.type + " 队列\n");
            }
            return true;
        }
        if (
            (command.type === "new" || command.type === "resume") &&
            isBusy()
        ) {
            write("当前任务尚未收尾，请等待完成或先 /abort\n");
            return true;
        }
        return false;
    }

    async function waitForIdle(): Promise<void> {
        await agent.waitForIdle();
        await activePrompt;
        await activeCompaction;
    }

    async function close(): Promise<void> {
        closed = true;
        abort();
        await waitForIdle();
    }

    return {
        startPrompt,
        handleControl,
        waitForIdle,
        abort,
        close,
        get isBusy(): boolean {
            return isBusy();
        },
    };
}
