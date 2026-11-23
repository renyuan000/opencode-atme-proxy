import type { Logger } from "./logger.js";
export type SessionKind = "coordinator" | "group" | "worker" | "child";
export interface SessionRecord {
    sessionId: string;
    directory: string;
    updatedAt: number;
    createdAt: number;
    kind: SessionKind;
    taskId?: string;
    chatId?: string;
    conversationId?: string;
    archivedAt?: number;
}
export declare class SessionStore {
    private readonly file;
    private sessions;
    private dirty;
    private readonly logger;
    constructor(file: string, logger?: Logger);
    load(): Promise<void>;
    get(key: string): SessionRecord | undefined;
    set(key: string, sessionId: string, directory: string, meta?: {
        kind?: SessionKind;
        taskId?: string;
        chatId?: string;
        conversationId?: string;
        createdAt?: number;
        archivedAt?: number;
    }): void;
    list(kind?: SessionKind): Array<[string, SessionRecord]>;
    delete(key: string): void;
    findByTask(taskId: string, kind?: SessionKind): Array<[string, SessionRecord]>;
    flush(): Promise<void>;
}
