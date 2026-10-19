import {writeFile} from "node:fs/promises";
import type {Tool, ToolArguments, ToolExecutionResult} from "../types.ts";
import {resolveSafePath} from "./tool-util.ts";

export class WriteFileTool implements Tool {
    readonly name = "write";
    workspaceRoot: string;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
    }

    readonly description = "写入或覆盖指定路径的文本文件";

    // 发给模型的参数 Schema；execute 仍要检查运行时参数，不能只相信模型符合约定。
    readonly parameters = {
        type: "object",
        properties: {
            path: {type: "string", description: "要写入的文件路径"},
            content: {type: "string", description: "要写入的文本内容"},
        },
        required: ["path", "content"],
        additionalProperties: false,
    };

    // 校验参数 → 安全解析路径 → fs.writeFile；Memory 路由另有格式与版本检查。
    async execute(args: ToolArguments, signal?: AbortSignal): Promise<ToolExecutionResult> {
        signal?.throwIfAborted();
        const path = args.path;
        const content = args.content;
        if (typeof path !== "string" || typeof content !== "string") {
            throw new Error("write 工具需要字符串类型的 path 和 content 参数");
        }
        // 异步解析真实路径必须 await；原 resolvePath 只做路径文本检查。
        const absolutePath = await resolveSafePath(this.workspaceRoot, path);
        // 这一步才实际调用 Node.js 文件系统；工具描述本身不会读写磁盘。
        await writeFile(absolutePath, content, {encoding: "utf8", signal});
        signal?.throwIfAborted();
        return {content: "已写入 " + path + "（" + content.length + " 字符）"};
    }

}