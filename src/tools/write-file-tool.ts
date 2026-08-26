import {writeFile} from "node:fs/promises";
import type {Tool, ToolArguments, ToolExecutionResult} from "../types.ts";
import {resolvePath} from "./tool-util.ts";

export class WriteFileTool implements Tool {
    readonly name = "write";
    workspaceRoot: string;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
    }

    readonly description = "写入或覆盖指定路径的文本文件";

    readonly parameters = {
        type: "object",
        properties: {
            path: {type: "string", description: "要写入的文件路径"},
            content: {type: "string", description: "要写入的文本内容"},
        },
        required: ["path", "content"],
        additionalProperties: false,
    };

    async execute(args: ToolArguments): Promise<ToolExecutionResult> {
        const path = args.path;
        const content = args.content;

        if (typeof path !== "string" || typeof content !== "string") {
            throw new Error("write 工具需要字符串类型的 path 和 content 参数");
        }

        const absolutePath = resolvePath(
            this.workspaceRoot,
            path,
        );

        await writeFile(absolutePath, content, "utf8");
        return {
            content: `已写入 ${path}（${content.length} 字符）`
        }
    }

}