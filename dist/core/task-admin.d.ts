import type { Logger } from "./logger.js";
import type { LlmClient } from "./relevance.js";
import type { TaskState } from "./types.js";
export type TaskAdminAction = "list" | "reanalyze" | "archive" | "restore";
export interface TaskAdminIntent {
    action: TaskAdminAction;
    group?: string;
    states: TaskState[];
    olderThanDays?: number;
    limit: number;
    reason?: string;
    confidence: number;
}
export interface TaskAdminIntentOptions {
    llm?: LlmClient;
    groups: string[];
    logger: Logger;
}
export declare class TaskAdminService {
    private readonly options;
    constructor(options: TaskAdminIntentOptions);
    infer(text: string): Promise<TaskAdminIntent | undefined>;
    private action;
    private deterministic;
}
