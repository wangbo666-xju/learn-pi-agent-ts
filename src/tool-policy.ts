import { basename } from "node:path";
import type {
    BeforeToolCall,
    ToolCall,
} from "./types.ts";

export type RequestToolApproval = (
    toolCall: ToolCall,
) => Promise<boolean>;

export function createToolPolicy(
    requestApproval: RequestToolApproval,
): BeforeToolCall {
    return async (toolCall) => {
        // 读文件、列目录默认允许
        if (
            toolCall.name === "read" ||
            toolCall.name === "listDir"
        ) {
            return undefined;
        }

        // 目前只有 write 是修改型工具
        if (toolCall.name === "write") {
            const path = toolCall.arguments.path;

            if (typeof path !== "string") {
                return {
                    block: true,
                    reason: "write 工具缺少 path 参数",
                };
            }

            // 策略：敏感文件不可写
            if (basename(path) === ".env") {
                return {
                    block: true,
                    reason: "禁止修改 .env 文件",
                };
            }

            // 具体“弹窗确认 / TUI 确认 / 自动放行”由外部注入
            const approved = await requestApproval(toolCall);

            if (!approved) {
                return {
                    block: true,
                    reason: `用户拒绝写入文件：${path}`,
                };
            }

            return undefined;
        }

        return {
            block: true,
            reason: `未配置工具策略：${toolCall.name}`,
        };
    };
}