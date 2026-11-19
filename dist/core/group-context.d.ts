import type { Logger } from "./logger.js";
export interface GroupSummary {
    chatId: string;
    summary: string;
    decisions: string[];
    assumptions: string[];
    openQuestions: string[];
    lastMessageAt: number;
    updatedAt: number;
}
export declare class GroupContextStore {
    private readonly file;
    private chats;
    private dirty;
    private readonly logger;
    constructor(file: string, logger?: Logger);
    load(): Promise<void>;
    get(chatId: string): GroupSummary | undefined;
    set(chatId: string, summary: GroupSummary): void;
    flush(): Promise<void>;
    size(): number;
    list(): GroupSummary[];
}
