import type { Logger } from "./logger.js";
import type { GroupStateLayout } from "./group-state.js";
export interface DocumentReference {
    url: string;
    title?: string;
    messageId?: string;
    senderId?: string;
    seenAt: number;
    lastFetchedAt?: number;
    status: "indexed" | "fetched" | "failed" | "skipped";
    cached: boolean;
}
export declare class ScopedDocumentRefs {
    private readonly layout;
    private readonly ttlMs;
    private readonly logger;
    private readonly maps;
    private readonly dirty;
    constructor(layout: GroupStateLayout, logger?: Logger, ttlMs?: number);
    private file;
    private map;
    load(): Promise<void>;
    record(chatId: string, input: {
        url: string;
        title?: string;
        messageId?: string;
        senderId?: string;
        status?: DocumentReference["status"];
        cached?: boolean;
    }): void;
    list(chatId: string, limit?: number): DocumentReference[];
    get(chatId: string, url: string): DocumentReference | undefined;
    flush(): Promise<void>;
}
