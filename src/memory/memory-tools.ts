import {isAbsolute, relative, resolve, sep} from "node:path";
import type {Tool} from "../types.ts";
import {ReadFileTool} from "../tools/read-file-tool.ts";
import {WriteFileTool} from "../tools/write-file-tool.ts";
import {ListDirTool} from "../tools/list-dir-tool.ts";
import type {MemoryWorkspace} from "./memory-workspace.ts";

export type MemoryToolSet = {
    tools: Tool[];
    clearReads(): void;
};

/** 包装现有文件工具：业务路径走原工具，Memory 路径走专用文件空间。 */
export function createMemoryFileTools(input: { workspace: MemoryWorkspace }): MemoryToolSet {
    const w = input.workspace;
    // 只记录本 Run 读过哪些文件，不做内容版本锁；本版没有后台并发写者。
    const reads = new Set<string>();
    const originals: Tool[] = [
        new ReadFileTool(w.workspaceRoot),
        new WriteFileTool(w.workspaceRoot),
        new ListDirTool(w.workspaceRoot),
        {
            name: "deleteFile",
            description: "只删除 Memory 目录中的单个事实文件；不可删除索引或业务文件",
            parameters: {
                type: "object",
                properties: {path: {type: "string"}},
                required: ["path"],
                additionalProperties: false,
            },
            execute: async () => {
                throw new Error("deleteFile 必须走 Memory 路由");
            },
        },
    ];
    const tools = originals.map((original): Tool => ({
        name: original.name,
        description: original.description + "；Memory 根目录：" + w.root,
        parameters: original.parameters,
        async execute(args, signal, onUpdate) {
            signal?.throwIfAborted();
            const raw = args.path ?? (original.name === "listDir" ? "." : undefined);
            if (typeof raw !== "string") throw new Error("工具需要字符串 path");
            const path = resolve(w.workspaceRoot, raw);
            const rel = relative(w.root, path);
            const inside = rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
            if (!inside) {
                if (original.name === "deleteFile") throw new Error("禁止删除业务文件");
                return original.execute(args, signal, onUpdate);
            }
            if (original.name === "listDir") {
                if (rel !== "") throw new Error("Memory 不允许子目录");
                return {content: (await w.list(signal)).join("\n") || "(空目录)"};
            }
            const target = await w.resolveFile(path);
            if (original.name === "read") {
                const content = await w.read(target, signal);
                reads.add(target);
                return {content: content ?? "文件尚不存在，可以创建。"};
            }
            if (!reads.has(target)) throw new Error("修改 Memory 前必须先 read");
            if (original.name === "write") {
                if (typeof args.content !== "string") throw new Error("write 需要字符串 content");
                await w.write(target, args.content, signal);
            } else {
                await w.delete(target, signal);
            }
            return {content: "Memory " + original.name + " 完成：" + target};
        },
    }));
    return {tools, clearReads: () => reads.clear()};
}