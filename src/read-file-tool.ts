import { readFile } from "node:fs/promises";
import type { Tool } from "./types.ts";

export class ReadFileTool implements Tool {
    readonly name = "read";

    async execute(args: { path: string }): Promise<string> {
        return readFile(args.path, "utf8");
    }
}