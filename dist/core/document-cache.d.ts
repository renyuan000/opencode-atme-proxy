import type { Logger } from "./logger.js";
import type { GroupStateLayout } from "./group-state.js";
export interface DocumentCacheEntry {
    url: string;
    title?: string;
    text: string;
    fetchedAt: number;
    lastUsedAt: number;
    hits: number;
}
export declare class ScopedDocumentCache {
    private readonly layout;
    private readonly ttlMs;
    private readonly logger;
    private readonly maps;
    private readonly dirty;
    constructor(layout: GroupStateLayout, logger?: Logger, ttlMs?: number);
    private file;
    private map;
    load(): Promise<void>;
    get(chatId: string, url: string): DocumentCacheEntry | undefined;
    set(chatId: string, entry: Omit<DocumentCacheEntry, "fetchedAt" | "lastUsedAt" | "hits">): void;
    flush(): Promise<void>;
}
