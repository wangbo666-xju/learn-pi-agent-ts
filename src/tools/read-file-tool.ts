import {readFile} from "node:fs/promises";
import type {Tool, ToolArguments, ToolExecutionResult} from "../types.ts";
import {resolveSafePath} from "./tool-util.ts";

export class ReadFileTool implements Tool {
    readonly name = "read";

    workspaceRoot: string;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
    }

    readonly description = "读取指定路径的文本文件";
    // 发给模型的参数 Schema；execute 仍要检查运行时参数，不能只相信模型符合约定。
    readonly parameters = {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "要读取的文件路径"
            }
        },
        required: ["path"],
        additionalProperties: false,
    };

    // 校验参数 → 安全解析路径 → fs.readFile → 返回工具结果。
    async execute(args: ToolArguments, signal?: AbortSignal): Promise<ToolExecutionResult> {
        signal?.throwIfAborted();
        const path = args.path;
        if (typeof path !== "string") {
            throw new Error("read 工具缺少字符串类型的 path 参数");
        }
        // 异步解析真实路径必须 await；原 resolvePath 只做路径文本检查。
        const absolutePath = await resolveSafePath(this.workspaceRoot, path);
        // 这一步才实际调用 Node.js 文件系统；工具描述本身不会读写磁盘。
        const content = await readFile(absolutePath, {encoding: "utf8", signal});
        signal?.throwIfAborted();
        return {content};
    }

}