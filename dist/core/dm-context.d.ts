import type { Logger } from "./logger.js";
import type { GroupStateLayout } from "./group-state.js";
export interface DmContext {
    chatId: string;
    summary: string;
    preferences: string[];
    decisions: string[];
    ongoingGoals: string[];
    openQuestions: string[];
    lastMessageAt: number;
    updatedAt: number;
    sessionEpoch: number;
}
export declare class DmContextStore {
    private readonly file;
    private conversations;
    private dirty;
    private readonly logger;
    constructor(file: string, logger?: Logger);
    load(): Promise<void>;
    get(chatId: string): DmContext | undefined;
    set(context: DmContext): void;
    flush(): Promise<void>;
}
export declare class ScopedDmContext {
    private readonly layout;
    private readonly stores;
    private readonly logger;
    constructor(layout: GroupStateLayout, logger?: Logger);
    load(): Promise<void>;
    get(chatId: string): DmContext | undefined;
    set(context: DmContext): void;
    flush(): Promise<void>;
    private store;
}
