import type { Logger } from "./logger.js";
import type { TaskEvent } from "./task-events.js";
export interface TaskNotification {
    id: string;
    taskId: string;
    chatId: string;
    kind: "candidate" | "approval" | "result" | "reminder";
    title: string;
    summary: string;
    cardMessageId?: string;
    sourceMessageId?: string;
    sourceUrl?: string;
    createdAt: number;
}
export declare class TaskStateDb {
    private readonly path;
    private readonly chatId;
    private readonly logger;
    private readonly db;
    constructor(path: string, chatId: string, logger?: Logger);
    markLegacyTasksImported(): void;
    private ensureTaskColumns;
    private ensureLinkIndexes;
    private backupBeforeMigration;
    private hasMigration;
    private markMigration;
    private migrateLegacy;
    linkMessage(messageId: string, taskId: string): void;
    linkSession(sessionId: string, taskId: string, role: string): void;
    findByMessage(messageId: string): string | undefined;
    findBySession(sessionId: string): {
        taskId: string;
        role: string;
    } | undefined;
    findByTask(taskId: string): Array<{
        sessionId: string;
        role: string;
    }>;
    getTask(taskId: string): string | undefined;
    listTaskData(): string[];
    taskCount(): number;
    recordNotification(input: Omit<TaskNotification, "id" | "createdAt"> & Partial<Pick<TaskNotification, "id" | "createdAt">>): TaskNotification;
    notificationsForTask(taskId: string, limit?: number): TaskNotification[];
    recentNotifications(limit?: number): TaskNotification[];
    private mapNotification;
    saveTask(taskId: string, data: string, updatedAt: number, dedupKey: string): void;
    taskIndex(): Array<{
        dedupKey: string;
        taskId: string;
    }>;
    saveTaskWithLinks(taskId: string, data: string, updatedAt: number, dedupKey: string, messageIds: string[]): void;
    linkMessageAndTask(messageId: string, taskId: string, data: string, updatedAt: number, dedupKey: string): void;
    publish(event: TaskEvent): void;
    cleanup(input: {
        linkDays: number;
        eventDays: number;
    }): {
        links: number;
        events: number;
    };
    backup(path: string): Promise<void>;
    close(): void;
}
