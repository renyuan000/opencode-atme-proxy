import type { PlatformAction, TaskAnalysis, TaskRecord } from "./types.js";
import type { PendingCard } from "./pending-store.js";
export interface Notifier {
    send(text: string): Promise<boolean>;
}
export interface AnalysisRepository {
    latest(taskId: string): Promise<TaskAnalysis | undefined>;
}
export interface ProjectLookup {
    resolve(chatId: string): Promise<{
        worktree: string;
        resolved: boolean;
    }>;
}
export interface ReplyActions {
    approve(action: PlatformAction, pending: PendingCard): Promise<void>;
}
export interface ExecutionActions {
    start(task: TaskRecord, planHash: string): void;
}
