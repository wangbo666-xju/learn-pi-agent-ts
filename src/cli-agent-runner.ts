export type PromptableAgent = {
	prompt(text: string): Promise<unknown>;
};

/**
 * CLI 统一执行 Prompt：无论普通输入还是 /skill 调用失败，都报告错误并保持输入循环继续运行。
 */
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
