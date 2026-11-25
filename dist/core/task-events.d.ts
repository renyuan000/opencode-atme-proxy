import { TaskStateDb } from "./task-state-db.js";
import type { GroupStateLayout } from "./group-state.js";
import type { Logger } from "./logger.js";
export type TaskEventType = "task.created" | "task.supplement" | "analysis.started" | "analysis.completed" | "analysis.failed" | "approval.sent" | "execution.started" | "execution.completed" | "review.completed" | "task.archived" | "task.reanalyze_requested";
export interface TaskEvent {
    eventId: string;
    type: TaskEventType;
    taskId: string;
    chatId: string;
    at: number;
    payload?: Record<string, unknown>;
}
export type TaskEventHandler = (event: TaskEvent) => void | Promise<void>;
export declare class TaskEventBus {
    private readonly handlers;
    private readonly logger;
    constructor(logger?: Logger);
    on(type: TaskEventType, handler: TaskEventHandler): void;
    publish(event: Omit<TaskEvent, "eventId" | "at"> & Partial<Pick<TaskEvent, "eventId" | "at">>): Promise<TaskEvent>;
}
export declare class ScopedTaskEvents {
    private readonly layout;
    private readonly logger;
    private readonly dbFor?;
    private readonly stores;
    constructor(layout: GroupStateLayout, logger?: Logger, dbFor?: ((chatId: string) => TaskStateDb) | undefined);
    private store;
    publish(chatId: string, event: Omit<TaskEvent, "eventId" | "at">): Promise<TaskEvent>;
    close(): void;
}
