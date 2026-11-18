import type { AppConfig } from "./config.js";
import type { AuditLog } from "./audit.js";
import type { ApprovalStore } from "./approval-store.js";
import type { Logger } from "./logger.js";
import type { PendingStore } from "./pending-store.js";
import type { PlatformAdapter } from "./ports.js";
import type { TaskStore } from "./task-store.js";
import type { PlatformAction, PlatformActionResult } from "./types.js";
import type { ExecutionActions, Notifier, ReplyActions } from "./runtime-ports.js";
export interface ApprovalServiceOptions {
    config: AppConfig;
    pending: PendingStore;
    tasks: TaskStore;
    approvals: ApprovalStore;
    audit: AuditLog;
    platform: PlatformAdapter;
    logger: Logger;
    ownerOpenId(): string | undefined;
    notifier: Notifier;
    replyActions: ReplyActions;
    executionActions: ExecutionActions;
}
export declare class ApprovalService {
    private readonly options;
    constructor(options: ApprovalServiceOptions);
    sweepExpiredApprovals(): Promise<void>;
    isAuthorizedActor(actor: {
        platform: string;
        id: string;
    }): Promise<boolean>;
    onAction(action: PlatformAction): Promise<PlatformActionResult>;
    private resolvedCardFor;
    private approveTask;
    private rejectTask;
}
