import type { Logger } from "./logger.js";
export interface SentReplyRecord {
    id: string;
    platform: string;
    chatId: string;
    chatName?: string;
    senderLabel: string;
    sourceMessageId: string;
    sentMessageId: string;
    text: string;
    sourceText: string;
    sentAt: number;
    status: "sent" | "recalled";
    recalledAt?: number;
}
export declare class SentReplyStore {
    private readonly file;
    private readonly ttlMs;
    private readonly maxEntries;
    private readonly logger;
    private replies;
    private chain;
    constructor(file: string, ttlMs?: number, maxEntries?: number, logger?: Logger);
    load(): Promise<void>;
    list(limit?: number): SentReplyRecord[];
    get(id: string): SentReplyRecord | undefined;
    add(input: Omit<SentReplyRecord, "id" | "status">): Promise<SentReplyRecord>;
    markRecalled(id: string, at?: number): Promise<boolean>;
    flush(): Promise<void>;
}
