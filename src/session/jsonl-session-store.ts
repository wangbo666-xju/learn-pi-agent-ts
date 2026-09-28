import {randomUUID} from "node:crypto";
import {
    appendFile,
    mkdir,
    readFile,
    writeFile,
} from "node:fs/promises";
import {dirname} from "node:path";
import type {AgentMessage} from "../types.ts";
import type {SessionStore} from "./session-store.ts";
import {
    CURRENT_SESSION_VERSION,
    type SessionFileItem,
    type SessionHeader,
    type SessionMessageEntry,
    type SessionMetadata,
    type SessionEntry,
    type CompactionInput,
    type SessionCompactionEntry,
} from "./types.ts";
import {validateCompaction} from "./build-agent-context.ts";

export class JsonlSessionStore implements SessionStore {

    private readonly filePath: string;
    private readonly metadata: SessionMetadata;
    private readonly entries: SessionEntry[];


    private readonly version: 1 | 2;

    constructor(
        filePath: string,
        metadata: SessionMetadata,
        entries: SessionEntry[],
        version: 1 | 2 = CURRENT_SESSION_VERSION,
    ) {
        this.filePath = filePath;
        this.metadata = metadata;
        this.entries = entries;
        this.version = version;
    }

    async appendMessage(message: AgentMessage): Promise<SessionMessageEntry> {
        const entry: SessionMessageEntry = {
            type: "message",
            id: randomUUID(),
            seq: this.entries.length + 1,
            timestamp: Date.now(),
            message: structuredClone(message),
        };
        // 重点：先写磁盘，写成功后再更新内存。
        await appendFile(
            this.filePath,
            `${JSON.stringify(entry)}\n`,
            "utf8",
        );
        this.entries.push(entry);
        return structuredClone(entry);

    }


    async getEntries(): Promise<SessionEntry[]> {
        return structuredClone(this.entries);
    }

    async getMessages(): Promise<AgentMessage[]> {
        return this.entries
            .filter((entry): entry is SessionMessageEntry => entry.type === "message")
            .map((entry) => structuredClone(entry.message));
    }

    async getMetadata(): Promise<SessionMetadata> {
        return structuredClone(this.metadata);
    }

    /**
     * 创建一个新的 Session 文件。
     */
    static async create(
        filePath: string,
        metadata: SessionMetadata,
    ): Promise<JsonlSessionStore> {
        await mkdir(dirname(filePath), {
            recursive: true
        });

        const header: SessionHeader = {
            type: "session",
            version: CURRENT_SESSION_VERSION,
            id: metadata.id,
            createdAt: metadata.createdAt

        }

        await writeFile(filePath,
            `${JSON.stringify(header)}\n`,
            {
                encoding: "utf8",
                flag: "wx",
            },
        )

        return new JsonlSessionStore(
            filePath,
            metadata,
            [],
        );
    }


    /**
     * 打开已有 JSONL，并把所有 Entry 恢复到内存。
     */
    static async open(
        filePath: string,
    ): Promise<JsonlSessionStore> {
        const content = await readFile(filePath, "utf8");
        const lines = content
            .split(/\r?\n/)
            .filter((line) => line.trim().length > 0);
        if (lines.length === 0) {
            throw new Error("Session 文件为空");
        }
        const items = lines.map(
            (line) => JSON.parse(line) as SessionFileItem,
        );
        const header = items[0];
        if (!header || header.type !== "session") {
            throw new Error("Session 文件缺少 header");
        }

        if (header.version !== 1 && header.version !== 2) {
            throw new Error(`不支持的 Session 版本：${header.version}`);
        }
        const entries: SessionEntry[] = [];
        for (let index = 1; index < items.length; index++) {
            const item = items[index];
            if (!item || (item.type !== "message" && item.type !== "compaction")) {
                throw new Error(`Session 第 ${index + 1} 行不是有效 Entry`);
            }
            if (item.seq !== entries.length + 1) throw new Error("Session seq 不连续");
            if (typeof item.id !== "string" || !item.id || entries.some((entry) => entry.id === item.id)) {
                throw new Error("Session Entry id 无效或重复");
            }
            if (item.type === "compaction") {
                if (header.version === 1) throw new Error("v1 会话不能包含 compaction");
                if (typeof item.summary !== "string" || typeof item.firstKeptEntryId !== "string") {
                    throw new Error("压缩记录字段无效");
                }
                validateCompaction(entries, item);
            }
            entries.push(item);
        }
        return new JsonlSessionStore(
            filePath,
            {
                id: header.id,
                createdAt: header.createdAt,
            },
            entries,
            header.version
        );
    }

    assertCanCompact(): void {
        if (this.version === 1) throw new Error("旧 v1 会话暂不支持压缩，请 /new 后体验");
    }

    async appendCompaction(input: CompactionInput): Promise<SessionCompactionEntry> {
        this.assertCanCompact();
        validateCompaction(this.entries, input);
        const entry: SessionCompactionEntry = {
            ...input, type: "compaction", id: randomUUID(),
            seq: this.entries.length + 1, timestamp: Date.now(),
        };
        await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
        this.entries.push(entry);
        return structuredClone(entry);
    }

}
