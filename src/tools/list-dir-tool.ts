import {readdir} from "node:fs/promises";
import type {Tool, ToolArguments} from "../types.ts";

export class ListDirTool implements Tool {
    readonly name = "listDir";

    readonly description = "列出指定目录下的文件和子目录名称";

    readonly parameters = {
        type: "object",
        properties: {
            path: {type: "string", description: "要列出的目录路径，默认当前目录"},
        },
        required: [],
        additionalProperties: false,
    };

    async execute(args: ToolArguments): Promise<string> {
        const path = typeof args.path === "string" ? args.path : ".";
        const entries = await readdir(path, {withFileTypes: true});

        return (
            entries
                .map((e) => (e.isDirectory() ? `[dir] ${e.name}` : `     ${e.name}`))
                .join("\n") || "(空目录)"
        );
    }
}