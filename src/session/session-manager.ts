import {join} from "node:path";
import {JsonlSessionStore} from "./jsonl-session-store.ts";
import {randomUUID} from "node:crypto";
import {mkdir, readdir} from "node:fs/promises";

export class SessionManager {
    private readonly sessionsDir: string;

    constructor(sessionsDir: string) {
        this.sessionsDir = sessionsDir;
    }


    /**
     * 创建一个独立的会话文件，并返回对应的 Store。
     */
    async create(): Promise<JsonlSessionStore> {
        const id = randomUUID();

        return JsonlSessionStore.create(this.getSessionPath(id), {
            id,
            createdAt: Date.now()
        });

    }

    /**
     * 根据 sessionId 打开已有会话。
     * JSONL Store 会在这里恢复历史消息。
     */
    async open(sessionId: string): Promise<JsonlSessionStore> {
        return JsonlSessionStore.open(this.getSessionPath(sessionId));
    }


    /**
     * 查询 sessions 目录下所有 Session 的 ID。
     */
    async listSessionIds(): Promise<string[]> {
        //保证 sessions/ 一定存在。
        // 因为用户可能第一次运行程序，此时目录还没有创建；不先创建，后面的 readdir() 会报“目录不存在”。recursive: true 表示目录已存在也不报错。
        await mkdir(this.sessionsDir, {recursive: true});
        //读取目录内容。withFileTypes: true 很关键：它返回的不只是文件名字符串，而是带类型信息的 Dirent 对象，所以可以判断它是文件还是文件夹。
        const entries = await readdir(this.sessionsDir, {
            withFileTypes: true,
        });
        //只保留“普通文件并且扩展名为 .jsonl”的项。
        return entries
            .filter((entry) =>
                entry.isFile() && entry.name.endsWith(".jsonl"),
            )
            .map((entry) => entry.name.slice(0, -".jsonl".length))
            .sort();
    }

    private getSessionPath(sessionId: string): string {
        return join(this.sessionsDir, `${sessionId}.jsonl`);
    }
}