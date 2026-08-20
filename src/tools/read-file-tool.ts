import {readFile} from "node:fs/promises";
import type {Tool, ToolArguments} from "../types.ts";
import {resolvePath} from "./tool-util.ts";

export class ReadFileTool implements Tool {
    readonly name = "read";

    workspaceRoot: string;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
    }

    readonly description = "读取指定路径的文本文件";
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


    async execute(args: ToolArguments): Promise<string> {
        const path = args.path;

        if (typeof path !== "string") {
            throw new Error("read 工具缺少字符串类型的 path 参数");
        }

        const absolutePath = resolvePath(
            this.workspaceRoot,
            path,
        );
        return readFile(absolutePath, "utf8");

    }


}