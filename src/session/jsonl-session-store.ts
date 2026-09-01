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
} from "./types.ts";

export class JsonlSessionStore implements SessionStore {

    private readonly filePath: string;
    private readonly metadata: SessionMetadata;
    private readonly entries: SessionMessageEntry[];


    constructor(filePath: string, metadata: SessionMetadata, entries: SessionMessageEntry[]) {
        this.filePath = filePath;
        this.metadata = metadata;
        this.entries = entries;
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


    async getEntries(): Promise<SessionMessageEntry[]> {
        return structuredClone(this.entries);
    }

    async getMessages(): Promise<AgentMessage[]> {
        return this.entries.map((entry) =>
            structuredClone(entry.message),
        );
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

        if (header.version !== CURRENT_SESSION_VERSION) {
            throw new Error(
                `不支持的 Session 版本：${header.version}`,
            );
        }
        const entries: SessionMessageEntry[] = [];
        for (let index = 1; index < items.length; index++) {

            const item = items[index];
            if (!item || item.type !== "message") {
                throw new Error(
                    `Session 第 ${index + 1} 行不是 message Entry`,
                );
            }

            const expectedSequence = entries.length + 1;
            if (item.seq !== expectedSequence) {
                throw new Error(
                    `Session seq 不连续：期望 ${expectedSequence}，实际 ${item.seq}`,
                );
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
        );
    }

}
