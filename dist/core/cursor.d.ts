import type { Logger } from "./logger.js";
export interface CursorRecord {
    lastEndTime: number;
    updatedAt: number;
    lastMessageId?: string;
    lastMessageTime?: number;
}
export interface CursorStoreOptions {
    file: string;
    logger?: Logger;
    now?: () => number;
}
export declare class CursorStore {
    private readonly options;
    private cursors;
    private dirty;
    private readonly logger;
    private readonly now;
    constructor(options: CursorStoreOptions);
    load(): Promise<void>;
    get(chatId: string): number | undefined;
    record(chatId: string): CursorRecord | undefined;
    set(chatId: string, lastEndTime: number, last?: {
        messageId?: string;
        messageTime?: number;
    }): void;
    flush(): Promise<void>;
}
