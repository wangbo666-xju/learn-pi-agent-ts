export type MemoryType = "user" | "feedback" | "project" | "reference";

export type MemoryManifestEntry = {
    name: string;
    description: string;
    type: MemoryType;
    fileName: string;
};

export const MEMORY_FILE_BYTES = 32 * 1024;
export const MEMORY_INDEX_CHARS = 8000;