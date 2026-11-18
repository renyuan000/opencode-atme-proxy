import type { AppConfig } from "./config.js";
import type { AuditLog } from "./audit.js";
import type { IntentService } from "./intent-service.js";
import type { Logger } from "./logger.js";
import type { ReplyService } from "./reply-service.js";
import type { TaskService } from "./task-service.js";
import type { TaskStore } from "./task-store.js";
import type { IncomingMessage } from "./types.js";
export interface MeMentionFlowOptions {
    config: AppConfig;
    logger: Logger;
    intentService: IntentService;
    replyService: ReplyService;
    taskService: TaskService;
    tasks: TaskStore;
    audit: AuditLog;
    prepare(message: IncomingMessage, signal: AbortSignal): Promise<{
        enriched: IncomingMessage;
        burst: IncomingMessage[];
    }>;
    markProcessed(message: IncomingMessage): Promise<void>;
    safeReply(message: IncomingMessage, text: string): Promise<boolean>;
    sendToApprover(text: string): Promise<boolean>;
}
export declare class MeMentionFlow {
    private readonly options;
    constructor(options: MeMentionFlowOptions);
    handle(message: IncomingMessage, signal: AbortSignal): Promise<void>;
    private complete;
    private sanitize;
}
