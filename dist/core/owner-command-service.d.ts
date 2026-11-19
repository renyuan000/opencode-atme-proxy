import type { AuditLog } from "./audit.js";
import type { Logger } from "./logger.js";
import type { PendingStore } from "./pending-store.js";
import type { PendingCard } from "./pending-store.js";
import type { PlatformAdapter } from "./ports.js";
import type { TokenBucket } from "./rate-limit.js";
import type { TaskStore } from "./task-store.js";
import type { IncomingMessage, PlatformAction } from "./types.js";
import type { ReplyStyle } from "./reply-style.js";
import type { OwnerCommand } from "./owner-command.js";
export interface OwnerCommandServiceOptions {
    pending: PendingStore;
    tasks: TaskStore;
    audit: AuditLog;
    platform: PlatformAdapter;
    sendLimiter: TokenBucket;
    ownerOpenId(): string | undefined;
    replyOptions: {
        defaultStyle: ReplyStyle;
    };
    analysisTimeoutMs: number;
    askOpenCode(message: IncomingMessage, style: ReplyStyle, signal: AbortSignal): Promise<string>;
    approveReply(action: PlatformAction, pending: PendingCard): Promise<boolean>;
    sendReplyManagementCard(): Promise<boolean>;
    setGroupResponsibility(arg: string): Promise<string>;
    logger: Logger;
}
export declare class OwnerCommandService {
    private readonly options;
    constructor(options: OwnerCommandServiceOptions);
    handle(message: IncomingMessage, command: OwnerCommand): Promise<string>;
    private replyPendingList;
    private resolveReplyPending;
    private replyOriginal;
    private resendReplyCard;
}
