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