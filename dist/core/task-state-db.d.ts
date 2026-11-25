import type { Logger } from "./logger.js";
import type { TaskEvent } from "./task-events.js";
export declare class TaskStateDb {
    private readonly path;
    private readonly chatId;
    private readonly logger;
    private readonly db;
    constructor(path: string, chatId: string, logger?: Logger);
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
    saveTask(taskId: string, data: string, updatedAt: number, dedupKey: string): void;
    taskIndex(): Array<{
        dedupKey: string;
        taskId: string;
    }>;
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
