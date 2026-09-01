import type {SessionStore} from "./session-store.ts";
import type {AgentMessage} from "../types.ts";
import type {
    SessionMessageEntry,
    SessionMetadata,
} from "./types.ts";
import {randomUUID} from "node:crypto";

export class MemorySessionStore implements SessionStore {


    private readonly metadata: SessionMetadata;
    private readonly entries: SessionMessageEntry[] = [];


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

    async getEntries(): Promise<SessionMessageEntry[]> {
        return structuredClone(this.entries);
    }


    async getMessages(): Promise<AgentMessage[]> {
        return this.entries.map((entry) =>
            structuredClone(entry.message),
        );
    }

}