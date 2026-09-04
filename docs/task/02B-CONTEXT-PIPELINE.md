# Task 2B：Context 管线 Implementation Plan

**Goal:** 固定模型调用前的处理顺序：先 `transformContext`，再 `convertToLlm`。

**Architecture:** `transformContext` 面向完整 Agent 上下文，未来承载裁剪和 Compact；`convertToLlm` 只负责输出模型认识的消息。当前默认实现不改变行为，只建立扩展边界。

**Spec:** `docs/PI_AGENT_LEARNING_DESIGN.md`

## 修改范围

```text
新增 src/context.ts
新增 test/context.test.ts
修改 package.json
```

## Step 1：先写失败测试

创建 `test/context.test.ts`：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {prepareLlmContext} from "../src/context.ts";
import type {AgentMessage} from "../src/types.ts";

test("先 transformContext 再 convertToLlm", async () => {
    const calls: string[] = [];

    const result = await prepareLlmContext(
        [{role: "user", content: "raw"}],
        async (messages) => {
            calls.push("transform");
            return [
                ...messages,
                {role: "user", content: "injected"},
            ];
        },
        (messages) => {
            calls.push("convert");
            return messages;
        },
    );

    assert.deepEqual(calls, ["transform", "convert"]);
    assert.deepEqual(result.map((message) => message.content), [
        "raw",
        "injected",
    ]);
});

test("transformContext 修改数组时不影响原始上下文", async () => {
    const original: AgentMessage[] = [
        {role: "user", content: "original"},
    ];

    await prepareLlmContext(
        original,
        async (messages) => {
            messages.push({role: "user", content: "temporary"});
            return messages;
        },
        (messages) => messages,
    );

    assert.equal(original.length, 1);
});
```

运行：

```powershell
npx tsx --test test/context.test.ts
```

预期：失败并提示找不到 `src/context.ts`。

## Step 2：实现 Context 类型和管线

创建 `src/context.ts`：

```ts
import type {
    AgentMessage,
    AssistantMessage,
    ToolResultMessage,
    UserMessage,
} from "./types.ts";

export type LlmMessage =
    | UserMessage
    | AssistantMessage
    | ToolResultMessage;

export type TransformContext = (
    messages: AgentMessage[],
    signal?: AbortSignal,
) => Promise<AgentMessage[]>;

export type ConvertToLlm = (
    messages: AgentMessage[],
) => LlmMessage[];

export const identityTransformContext: TransformContext =
    async (messages) => messages;

export const defaultConvertToLlm: ConvertToLlm =
    (messages) => messages.filter(
        (message): message is LlmMessage =>
            message.role === "user" ||
            message.role === "assistant" ||
            message.role === "toolResult",
    );

export async function prepareLlmContext(
    messages: AgentMessage[],
    transformContext: TransformContext = identityTransformContext,
    convertToLlm: ConvertToLlm = defaultConvertToLlm,
    signal?: AbortSignal,
): Promise<LlmMessage[]> {
    const transformed = await transformContext([...messages], signal);
    return convertToLlm(transformed);
}
```

## Step 3：理解顺序

```text
AgentState.messages
  ↓ 完整 Agent 消息
transformContext
  ↓ 裁剪、摘要或注入后的 Agent 消息
convertToLlm
  ↓ 只有模型支持的角色
LlmClient.chatStream
```

现在 `AgentMessage` 恰好只有三种模型角色，所以默认 `convertToLlm` 看起来接近恒等函数。保留它是为了以后加入 UI 消息或 Compact Record 时，不修改 Provider。

## Step 4：加入完整测试命令

把 `test/context.test.ts` 追加到 `package.json` 的 `test` 脚本，然后执行：

```powershell
npx tsx --test test/context.test.ts
npm test
npm run check
```

预期：所有命令退出码为 0，现有 CLI 行为不变。Task 3 再把 `prepareLlmContext()` 接入 Agent Loop。

建议提交：

```text
feat(agent): add context transformation pipeline
```
