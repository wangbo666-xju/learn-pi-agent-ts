import {readFile} from "node:fs/promises";
import type {Tool, ToolArguments} from "./types.ts";

export class ReadFileTool implements Tool {
    readonly name = "read";


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

        return readFile(path, "utf8");

    }


}