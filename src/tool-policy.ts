import { basename } from "node:path";
import type {
    BeforeToolCall,
    ToolCall,
} from "./types.ts";

// 外部注入审批行为；这里不决定使用弹窗、终端询问还是直接放行。
export type RequestToolApproval = (
    toolCall: ToolCall,
) => Promise<boolean>;

// 返回 beforeToolCall 钩子，由 executeTools 在工具执行前调用。
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

        // write 和受限的 Memory deleteFile 都需要通过修改策略。
        // 审批只是入口规则；deleteFile 的具体路径限制仍由 Memory 工具强制执行。
        if (toolCall.name === "write" || toolCall.name === "deleteFile") {
            const path = toolCall.arguments.path;

            if (typeof path !== "string") {
                return {
                    block: true,
                    reason: toolCall.name + " 工具缺少 path 参数",
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

        // 未知工具默认拒绝；不会因为模型写了一个工具名就获得新权限。
        return {
            block: true,
            reason: `未配置工具策略：${toolCall.name}`,
        };
    };
}