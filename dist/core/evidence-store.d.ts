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
        name?: string;
        size?: number;
    }>;
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
    constructor(options: EvidenceStoreOptions);
    append(record: EvidenceRecord): void;
    search(input: {
        chatId: string;
        terms: string[];
        days?: number;
        limit?: number;
    }): EvidenceRecord[];
    findByMessageId(input: {
        chatId: string;
        messageId: string;
        days?: number;
    }): EvidenceRecord | undefined;
    redact(chatId: string, messageId: string): void;
    prune(): void;
    private findChatDirs;
    private chatDir;
}
