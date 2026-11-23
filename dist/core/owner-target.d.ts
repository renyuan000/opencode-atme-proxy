import type { Logger } from "./logger.js";
export interface OwnerTarget {
    ownerId: string;
    chatId: string;
    conversationId?: string;
    chatName?: string;
    sourceMessageId?: string;
    taskId?: string;
    updatedAt: number;
}
export declare class OwnerTargetStore {
    private readonly file;
    private targets;
    private dirty;
    private readonly logger;
    constructor(file: string, logger?: Logger);
    load(): Promise<void>;
    list(ownerId: string, maxAgeMs?: number): OwnerTarget[];
    get(ownerId: string, maxAgeMs?: number): OwnerTarget | undefined;
    set(target: OwnerTarget): void;
    select(ownerId: string, value: string): OwnerTarget | undefined;
    clear(ownerId: string): void;
    flush(): Promise<void>;
}
