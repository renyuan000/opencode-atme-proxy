import type { Logger } from "./logger.js";
export type MemoryKind = "task" | "decision" | "fact" | "preference" | "deadline" | "outcome";
export interface MemoryRecord {
    id: string;
    platform: string;
    chatId?: string;
    projectId?: string;
    kind: MemoryKind;
    key: string;
    value: string;
    sourceMessageIds: string[];
    tags: string[];
    confidence: number;
    pinned: boolean;
    createdAt: number;
    updatedAt: number;
    expiresAt?: number;
}
export interface MemoryStoreOptions {
    file: string;
    shardDir?: string;
    requireSource?: boolean;
    maxEntries: number;
    ttlMs: number;
    pinnedKinds: MemoryKind[];
    logger?: Logger;
    now?: () => number;
}
export interface MemoryInput {
    platform: string;
    kind: MemoryKind;
    key: string;
    value: string;
    chatId?: string;
    projectId?: string;
    sourceMessageIds?: string[];
    tags?: string[];
    confidence?: number;
    pinned?: boolean;
    ttlMs?: number;
}
export interface MemoryQuery {
    platform: string;
    chatId?: string;
    projectId?: string;
    text?: string;
    limit: number;
}
export declare class MemoryStore {
    private readonly options;
    private entries;
    private dirty;
    private readonly dirtyShards;
    private readonly history;
    private readonly logger;
    private readonly now;
    private readonly pinnedKinds;
    private readonly shardDir?;
    private readonly requireSource;
    constructor(options: MemoryStoreOptions);
    load(): Promise<void>;
    upsert(input: MemoryInput): MemoryRecord;
    get(id: string): MemoryRecord | undefined;
    delete(id: string): boolean;
    query(input: MemoryQuery): MemoryRecord[];
    prune(): void;
    size(): number;
    flush(): Promise<void>;
    migrateShards(): Promise<void>;
    private writeShards;
}
