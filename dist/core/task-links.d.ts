import type { GroupStateLayout } from "./group-state.js";
import type { Logger } from "./logger.js";
import { TaskStateDb, type TaskNotification, type TaskRun } from "./task-state-db.js";
interface TaskLinkFile {
    version: 1;
    byMessage: Record<string, string>;
    bySession: Record<string, {
        taskId: string;
        role: string;
    }>;
}
export declare class TaskLinkStore {
    private readonly path;
    private file;
    private dirty;
    private readonly logger;
    constructor(path: string, logger?: Logger);
    load(): Promise<void>;
    linkMessage(messageId: string, taskId: string): Promise<void>;
    linkSession(sessionId: string, taskId: string, role: string): Promise<void>;
    findByMessage(messageId: string): string | undefined;
    findBySession(sessionId: string): {
        taskId: string;
        role: string;
    } | undefined;
    findByTask(taskId: string): Array<{
        sessionId: string;
        role: string;
    }>;
    snapshot(): TaskLinkFile;
    flush(): Promise<void>;
}
export declare class ScopedTaskLinks {
    private readonly layout;
    private readonly stores;
    private readonly logger;
    constructor(layout: GroupStateLayout, logger?: Logger);
    load(): Promise<void>;
    database(chatId: string): TaskStateDb;
    private store;
    linkMessage(chatId: string, messageId: string, taskId: string): Promise<void>;
    linkSession(chatId: string, sessionId: string, taskId: string, role: string): Promise<void>;
    findByMessage(chatId: string, messageId: string): string | undefined;
    findByMessageAny(messageId: string): string | undefined;
    findBySession(chatId: string, sessionId: string): {
        taskId: string;
        role: string;
    } | undefined;
    startRun(input: {
        taskId: string;
        chatId: string;
        role: string;
        stage: string;
        sessionId?: string;
    }): TaskRun;
    attachRunSession(chatId: string, runId: string, sessionId: string): void;
    finishRun(chatId: string, runId: string, status: string): void;
    touchRun(chatId: string, runId: string): void;
    staleRuns(stallMs: number): Array<TaskRun & {
        chatId: string;
    }>;
    markRunStalled(chatId: string, runId: string): void;
    currentRun(taskId: string): TaskRun | undefined;
    recordNotification(input: Omit<TaskNotification, "id" | "createdAt">): TaskNotification;
    notificationsForTask(taskId: string, limit?: number): TaskNotification[];
    recentNotifications(limit?: number): TaskNotification[];
    findByTask(taskId: string): Array<{
        chatId: string;
        sessionId: string;
        role: string;
    }>;
    flush(): Promise<void>;
    purgeTasks(input: {
        needsInfoDays: number;
        awaitingApprovalDays: number;
        terminalDays: number;
        archivedDays: number;
    }): Array<{
        chatId: string;
        taskId: string;
    }>;
    cleanupTombstones(days: number): number;
    cleanup(linkDays: number, eventDays: number): {
        links: number;
        events: number;
    };
    close(): void;
}
export {};
