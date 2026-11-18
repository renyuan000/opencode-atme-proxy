import type { PendingCard } from "./pending-store.js";
import type { PlatformAction, TaskAnalysis, TaskRecord } from "./types.js";
import type { IncomingMessage } from "./types.js";
import type { ReplyStyle } from "./reply-style.js";
export interface Notifier {
    sendOwner(text: string): Promise<boolean>;
    sendApprover(text: string): Promise<boolean>;
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
export interface ReplyDrafter {
    draft(message: IncomingMessage, style: ReplyStyle, signal: AbortSignal): Promise<string>;
}
export interface ExecutionActions {
    start(task: TaskRecord, planHash: string): void;
}
