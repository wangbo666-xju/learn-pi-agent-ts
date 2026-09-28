import type {SessionStore} from "./session-store.ts";
import type {AgentMessage} from "../types.ts";
import type {
    SessionMessageEntry,
    SessionMetadata,
    SessionEntry, CompactionInput, SessionCompactionEntry
} from "./types.ts";
import {validateCompaction} from "./build-agent-context.ts";

import {randomUUID} from "node:crypto";

export class MemorySessionStore implements SessionStore {


    private readonly metadata: SessionMetadata;
    private readonly entries: SessionEntry[] = [];

    constructor(metadata: SessionMetadata) {
        this.metadata = metadata;
    }

    async getMetadata(): Promise<SessionMetadata> {
        return structuredClone(this.metadata);
    }

    async appendMessage(message: AgentMessage): Promise<SessionMessageEntry> {
        const entry: SessionMessageEntry = {
            type: "message",
            id: randomUUID(),
            seq: this.entries.length + 1,
            timestamp: Date.now(),
            message: structuredClone(message),
        }
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

    async appendCompaction(input: CompactionInput): Promise<SessionCompactionEntry> {
        validateCompaction(this.entries, input);
        const entry: SessionCompactionEntry = {
            ...input, type: "compaction", id: randomUUID(),
            seq: this.entries.length + 1, timestamp: Date.now(),
        };
        this.entries.push(entry);
        return structuredClone(entry);
    }


    assertCanCompact(): void {
    }

}
