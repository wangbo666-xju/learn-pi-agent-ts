import {readdir} from "node:fs/promises";
import type {Tool, ToolArguments, ToolExecutionResult} from "../types.ts";
import {resolvePath} from "./tool-util.ts";

export class ListDirTool implements Tool {
    readonly name = "listDir";
    workspaceRoot: string;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
    }

    readonly description = "列出指定目录下的文件和子目录名称";

    readonly parameters = {
        type: "object",
        properties: {
            path: {type: "string", description: "要列出的目录路径，默认当前目录"},
        },
        required: [],
        additionalProperties: false,
    };

    async execute(args: ToolArguments, signal?: AbortSignal): Promise<ToolExecutionResult> {
        signal?.throwIfAborted();
        if (args.path !== undefined && typeof args.path !== "string") {
            throw new Error("listDir 的 path 必须是字符串");
        }
        const path = typeof args.path === "string" ? args.path : ".";
        const absolutePath = resolvePath(this.workspaceRoot, path);
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