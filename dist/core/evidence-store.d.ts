import type { Logger } from "./logger.js";
export interface EvidenceRecord {
    ts: number;
    platform: string;
    chatId: string;
    chatName?: string;
    messageId: string;
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
    constructor(options: EvidenceStoreOptions);
    append(record: EvidenceRecord): void;
    search(input: {
        chatId: string;
        terms: string[];
        days?: number;
        limit?: number;
    }): EvidenceRecord[];
    prune(): void;
    private findChatDirs;
    private chatDir;
}
