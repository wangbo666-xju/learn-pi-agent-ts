import {createHash, randomUUID} from "node:crypto";
import {lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile} from "node:fs/promises";
import {homedir} from "node:os";
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from "node:path";
import {MEMORY_FILE_BYTES, type MemoryManifestEntry, type MemoryType} from "./types.ts";

const FACT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

function isMissing(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** 只解析约定的固定文件头，不是通用 YAML 解析器。 */
export function parseMemoryFact(fileName: string, content: string): MemoryManifestEntry {
    const match = /^---\r?\nname: (.+)\r?\ndescription: (.+)\r?\nmetadata:\r?\n  type: (user|feedback|project|reference)\r?\n---\r?\n([\s\S]+)$/.exec(content);
    if (!match || !match[4]!.trim()) throw new Error("记忆文件头或正文无效");
    const scalar = (raw: string): string => {
        const value: unknown = raw.startsWith('"') ? JSON.parse(raw) : raw.trim();
        if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value)) {
            throw new Error("记忆字段必须是非空单行字符串");
        }
        return value;
    };
    const name = scalar(match[1]!);
    if (!FACT_NAME.test(fileName) || name + ".md" !== fileName) {
        throw new Error("记忆 name 必须与文件名一致");
    }
    return {name, description: scalar(match[2]!), type: match[3] as MemoryType, fileName};
}

/** 文件访问层：不知道 Agent、Session 和 LLM，只负责记忆目录。 */
export class MemoryWorkspace {
    readonly root: string;
    readonly workspaceRoot: string;

    constructor(root: string, workspaceRoot: string) {
        this.root = root;
        this.workspaceRoot = workspaceRoot;
    }

    /** 防止实例创建后，根目录被替换成链接。 */
    private async checkRoot(): Promise<void> {
        const stat = await lstat(this.root);
        if (stat.isSymbolicLink() || !stat.isDirectory() || await realpath(this.root) !== this.root) {
            throw new Error("Memory 根目录不是原来的真实目录");
        }
    }

    /** 只允许根目录直接下属的 MEMORY.md 或 slug.md，不允许子目录、链接和其他后缀。 */
    async resolveFile(input: string): Promise<string> {
        await this.checkRoot();
        const path = isAbsolute(input) ? resolve(input) : resolve(this.root, input);
        const name = basename(path);
        if (relative(this.root, dirname(path)) !== "" ||
            (name !== "MEMORY.md" && !FACT_NAME.test(name))) {
            throw new Error("Memory 仅允许根目录内的 Markdown 文件");
        }
        try {
            const stat = await lstat(path);
            if (stat.isSymbolicLink() || !stat.isFile() || await realpath(path) !== path) {
                throw new Error("Memory 禁止链接、目录和路径别名");
            }
        } catch (error) {
            if (!isMissing(error)) throw error;
        }
        return path;
    }

    /** 不存在返回 undefined；与空文件区分。其他错误继续抛出。 */
    async read(input: string, signal?: AbortSignal): Promise<string | undefined> {
        signal?.throwIfAborted();
        const path = await this.resolveFile(input);
        try {
            if ((await lstat(path)).size > MEMORY_FILE_BYTES) throw new Error("记忆超过 32 KiB");
            const content = await readFile(path, {encoding: "utf8", signal});
            if (Buffer.byteLength(content) > MEMORY_FILE_BYTES) throw new Error("记忆超过 32 KiB");
            signal?.throwIfAborted();
            return content;
        } catch (error) {
            if (isMissing(error)) return undefined;
            throw error;
        }
    }

    async list(signal?: AbortSignal): Promise<string[]> {
        signal?.throwIfAborted();
        await this.checkRoot();
        const entries = await readdir(this.root, {withFileTypes: true});
        signal?.throwIfAborted();
        return entries.filter((entry) => entry.isFile() &&
            (entry.name === "MEMORY.md" || FACT_NAME.test(entry.name)))
            .map((entry) => entry.name).sort();
    }

    /** 首次没有索引正常；格式不正确则交给 Runtime 警告，不静默当作有效索引。 */
    async readIndex(signal?: AbortSignal): Promise<string> {
        const content = await this.read("MEMORY.md", signal) ?? "";
        this.validate("MEMORY.md", content);
        return content;
    }

    private validate(fileName: string, content: string): void {
        if (Buffer.byteLength(content) > MEMORY_FILE_BYTES) throw new Error("记忆超过 32 KiB");
        if (fileName !== "MEMORY.md") {
            parseMemoryFact(fileName, content);
            return;
        }
        for (const line of content.split(/\r?\n/).filter((line) => line.trim())) {
            if (!/^- \[[^\]]+\]\([a-z0-9]+(?:-[a-z0-9]+)*\.md\)\s+—\s+\S.*$/.test(line)) {
                throw new Error("索引每行必须是：- [标题](slug.md) — 何时读取");
            }
        }
    }

    /** 先写临时文件再替换；只保证单文件替换，不保证事实和索引的双文件事务。 */
    async write(input: string, content: string, signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        const path = await this.resolveFile(input);
        this.validate(basename(path), content);
        const temporary = join(this.root, ".memory-" + randomUUID() + ".tmp");
        try {
            await writeFile(temporary, content, {encoding: "utf8", flag: "wx", signal});
            await this.resolveFile(path);
            signal?.throwIfAborted();
            await rename(temporary, path); // 提交点；成功后发生取消，不回滚已写内容。
        } finally {
            await unlink(temporary).catch((error: unknown) => {
                if (!isMissing(error)) throw error;
            });
        }
    }

    /** 删除单个事实。索引不能删，但可以写成空字符串。 */
    async delete(input: string, signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        const path = await this.resolveFile(input);
        if (basename(path) === "MEMORY.md") throw new Error("禁止删除索引 MEMORY.md");
        signal?.throwIfAborted();
        await unlink(path).catch((error: unknown) => {
            if (!isMissing(error)) throw error;
        });
    }
}

/** Memory 必须在业务工作区外，避免通过普通文件工具绕过记忆专用校验。 */
function assertMemoryOutsideWorkspace(workspaceRoot: string, target: string): void {
    const rel = relative(workspaceRoot, target);
    if (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel)) {
        throw new Error("Memory 目录必须位于项目工作区之外");
    }
}

/** 同项目共享目录；不同 Session 不产生新的 Memory 目录。 */
export async function createMemoryWorkspace(options: {
    workspaceRoot: string;
    dataRoot?: string;
}): Promise<MemoryWorkspace> {
    const workspaceRoot = await realpath(options.workspaceRoot);
    const identity = process.platform === "win32"
        ? workspaceRoot.replaceAll("\\", "/").toLowerCase() : workspaceRoot;
    const projectId = createHash("sha256").update(identity).digest("hex");
    const root = resolve(options.dataRoot ?? join(homedir(), ".agent-ts", "memories"),
        "projects", projectId, "memory");
    assertMemoryOutsideWorkspace(workspaceRoot, root);

    // 目标可能尚未创建：向上找到已有祖先，再解析链接并拼回缺失部分。
    // 必须在 mkdir 前检查，不能先在项目内创建目录再报错。
    let ancestor = root;
    const missing: string[] = [];
    while (true) {
        try {
            await lstat(ancestor);
            break;
        } catch (error) {
            if (!isMissing(error) || dirname(ancestor) === ancestor) throw error;
            missing.unshift(basename(ancestor));
            ancestor = dirname(ancestor);
        }
    }
    // 放在循环外：已有悬空链接的 realpath 失败必须抛出，不能当成普通缺失目录。
    const actualRoot = resolve(await realpath(ancestor), ...missing);
    assertMemoryOutsideWorkspace(workspaceRoot, actualRoot);
    await mkdir(root, {recursive: true});
    if ((await lstat(root)).isSymbolicLink()) throw new Error("Memory 根目录不能是链接");
    const createdRoot = await realpath(root);
    assertMemoryOutsideWorkspace(workspaceRoot, createdRoot);
    return new MemoryWorkspace(createdRoot, workspaceRoot);
}
