import {readdir} from "node:fs/promises";
import type {Tool, ToolArguments, ToolExecutionResult} from "../types.ts";
import {resolveSafePath} from "./tool-util.ts";

export class ListDirTool implements Tool {
    readonly name = "listDir";
    workspaceRoot: string;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
    }

    readonly description = "列出指定目录下的文件和子目录名称";

    // 发给模型的参数 Schema；execute 仍要检查运行时参数，不能只相信模型符合约定。
    readonly parameters = {
        type: "object",
        properties: {
            path: {type: "string", description: "要列出的目录路径，默认当前目录"},
        },
        required: [],
        additionalProperties: false,
    };

    // 列项目目录；path 默认 .，真实路径检查通过后再执行 readdir。
    async execute(args: ToolArguments, signal?: AbortSignal): Promise<ToolExecutionResult> {
        signal?.throwIfAborted();
        if (args.path !== undefined && typeof args.path !== "string") {
            throw new Error("listDir 的 path 必须是字符串");
        }
        const path = typeof args.path === "string" ? args.path : ".";
        // 异步解析真实路径必须 await；原 resolvePath 只做路径文本检查。
        const absolutePath = await resolveSafePath(this.workspaceRoot, path);
        // 这一步才实际调用 Node.js 文件系统；工具描述本身不会读写磁盘。
        const entries = await readdir(absolutePath, {withFileTypes: true});
        // readdir 没有在这里传 signal；只能在操作前后响应取消。
        signal?.throwIfAborted();
        return {
            content: entries.map((entry) =>
                (entry.isDirectory() ? "[dir] " : "     ") + entry.name,
            ).join("\n") || "(空目录)",
        };
    }

}