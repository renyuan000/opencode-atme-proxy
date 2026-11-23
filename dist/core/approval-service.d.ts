import type { AppConfig } from "./config.js";
import type { AuditLog } from "./audit.js";
import type { ApprovalStore } from "./approval-store.js";
import type { Logger } from "./logger.js";
import type { PendingStore } from "./pending-store.js";
import type { PendingCard } from "./pending-store.js";
import type { PlatformAdapter } from "./ports.js";
import type { SentReplyStore } from "./sent-reply-store.js";
import type { TaskStore } from "./task-store.js";
import type { PlatformAction, PlatformActionResult, TaskRecord } from "./types.js";
export interface ApprovalServiceOptions {
    config: AppConfig;
    pending: PendingStore;
    tasks: TaskStore;
    approvals: ApprovalStore;
    audit: AuditLog;
    platform: PlatformAdapter;
    logger: Logger;
    ownerOpenId(): string | undefined;
    sendToApprover(text: string): Promise<boolean>;
    approveReply(action: PlatformAction, pending: PendingCard): Promise<boolean>;
    sentReplies: SentReplyStore;
    startExecution(task: TaskRecord, planHash: string): void;
}
export declare class ApprovalService {
    private readonly options;
    constructor(options: ApprovalServiceOptions);
    private readonly inflight;
    private readonly nameCache;
    sweepExpiredApprovals(): Promise<void>;
    isAuthorizedActor(actor: {
        platform: string;
        id: string;
    }): Promise<boolean>;
    onAction(action: PlatformAction): Promise<PlatformActionResult>;
    private handleAction;
    private resolvedCardFor;
    private cancelPendingNow;
    private pendingApprovalCard;
    sendReplyManagementCard(withNames?: boolean): Promise<boolean>;
    private groupLabel;
    private replyManagementResult;
    private resolveSenderLabel;
    private restorePendingDraft;
    private restoreRecalledDrafts;
    private replyManagementView;
    private approveTask;
    private rejectTask;
}
