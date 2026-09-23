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
) {
    let activePrompt: Promise<void> | undefined;
    let closed = false;

    function startPrompt(text: string): void {
        if (closed) {
            write("当前会话控制器已关闭\n");
            return;
        }
        if (activePrompt || agent.state.isRunning) {
            write("Agent 正在运行，请使用 /steer、/followup 或 /abort\n");
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

    /**
     * true：本命令已经处理，main 不再路由。
     * false：交回 main 处理会话、Skill 或普通 Prompt。
     */
    function handleControl(command: CliCommand): boolean {
        if (command.type === "status") {
            write(JSON.stringify({
                isRunning: agent.state.isRunning,
                isSettling: Boolean(activePrompt) && !agent.state.isRunning,
                pendingToolCalls: [...agent.state.pendingToolCalls],
                errorMessage: agent.state.errorMessage,
            }) + "\n");
            return true;
        }
        if (command.type === "abort") {
            agent.abort();
            write("已请求取消；等待当前操作响应并完成收尾\n");
            return true;
        }
        if (command.type === "steer" || command.type === "followup") {
            if (!command.text) {
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
            (activePrompt || agent.state.isRunning)
        ) {
            write("当前任务尚未收尾，请等待完成或先 /abort\n");
            return true;
        }
        return false;
    }

    async function waitForIdle(): Promise<void> {
        await agent.waitForIdle();
        await activePrompt;
    }

    async function close(): Promise<void> {
        closed = true;
        agent.abort();
        await waitForIdle();
    }

    return {
        startPrompt,
        handleControl,
        waitForIdle,
        close,
        get isBusy(): boolean {
            return Boolean(activePrompt) || agent.state.isRunning;
        },
    };
}
