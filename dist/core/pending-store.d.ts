import type { Logger } from "./logger.js";
import type { ApprovalView } from "./types.js";
export interface PendingCard {
    platform: string;
    taskId: string;
    mode: "reply" | "develop";
    planHash: string;
    analysisVersion: number;
    actorId: string;
    chatId?: string;
    messageId?: string;
    sourceMessageId?: string;
    style?: "concise" | "detailed";
    draft?: string;
    view?: ApprovalView;
    createdAt: number;
}
export declare class PendingStore {
    private readonly file;
    private cards;
    private dirty;
    private readonly logger;
    constructor(file: string, logger?: Logger);
    load(): Promise<void>;
    get(key: string): PendingCard | undefined;
    findForTask(taskId: string): PendingCard | undefined;
    set(key: string, card: PendingCard): void;
    delete(key: string): void;
    snapshot(): Array<[string, PendingCard]>;
    deleteForTask(taskId: string): void;
    flush(): Promise<void>;
}
