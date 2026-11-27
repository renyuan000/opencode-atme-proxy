import type { Logger } from "./logger.js";
export interface EvidenceRecord {
    ts: number;
    platform: string;
    chatId: string;
    chatName?: string;
    messageId: string;
    replyToMessageId?: string;
    threadId?: string;
    direction: "inbound" | "outbound";
    senderId?: string;
    senderName?: string;
    origin?: string;
    text: string;
    attachments?: Array<{
        kind: string;
        key?: string;
        name?: string;
        size?: number;
        mime?: string;
        localPath?: string;
    }>;
}
export interface EvidenceMessageChain {
    reply: EvidenceRecord[];
    thread: EvidenceRecord[];
}
export interface EvidenceStoreOptions {
    dir: string;
    enabled?: boolean;
    retentionDays: number;
    maxChars: number;
    logger?: Logger;
    now?: () => number;
}
export declare class EvidenceStore {
    private readonly options;
    private readonly enabled;
    private readonly logger;
    private readonly now;
    private readonly dirs;
    private readonly activeMonths;
    private readonly indexes;
    private writeQueue;
    constructor(options: EvidenceStoreOptions);
    append(record: EvidenceRecord): Promise<void>;
    flush(): Promise<void>;
    search(input: {
        chatId: string;
        terms: string[];
        days?: number;
        limit?: number;
    }): Promise<EvidenceRecord[]>;
    findByMessageId(input: {
        chatId: string;
        messageId: string;
        days?: number;
    }): Promise<EvidenceRecord | undefined>;
    findReplyChain(input: {
        chatId: string;
        messageId: string;
        maxDepth?: number;
        days?: number;
    }): Promise<EvidenceRecord[]>;
    findMessageChain(input: {
        chatId: string;
        messageId: string;
        maxDepth?: number;
        maxThread?: number;
        days?: number;
    }): Promise<EvidenceMessageChain>;
    private ensureIndex;
    redact(chatId: string, messageId: string): Promise<void>;
    prune(): Promise<void>;
    private findChatDirs;
    private readActiveMonth;
    private chatDir;
}
