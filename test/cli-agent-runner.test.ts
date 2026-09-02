import assert from "node:assert/strict";
import test from "node:test";
import { runAgentPrompt } from "../src/cli-agent-runner.ts";

test("Agent 执行失败时保留 CLI 进程并报告错误", async () => {
	const errors: string[] = [];

	await runAgentPrompt(
		{
			async prompt(): Promise<void> {
				throw new Error("模型请求失败");
			},
		},
		"测试输入",
		(message) => errors.push(message),
	);

	assert.deepEqual(errors, ["模型请求失败"]);
});
