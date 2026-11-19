import type { AppConfig } from "./config.js";
import type { AuditLog } from "./audit.js";
import type { IntentService } from "./intent-service.js";
import type { Logger } from "./logger.js";
import type { OpenCodeBridge } from "./opencode.js";
import type { PlatformAdapter } from "./ports.js";
import type { TokenBucket } from "./rate-limit.js";
import type { ReplyService } from "./reply-service.js";
import type { SessionManager, SessionPermission } from "./session-manager.js";
import type { BotIntent, IncomingMessage } from "./types.js";
export interface BotMentionFlowOptions {
    config: AppConfig;
    logger: Logger;
    intentService: IntentService;
    replyService: ReplyService;
    sessionManager: SessionManager;
    bridge: OpenCodeBridge;
    platform: PlatformAdapter;
    sendLimiter: TokenBucket;
    audit: AuditLog;
    readOnlyPermission: SessionPermission[];
    ownerOpenId(): string | undefined;
    ownerName(): string;
    resolveProject(chatId: string): Promise<{
        worktree: string;
        resolved: boolean;
    }>;
    sendToOwner(text: string): Promise<boolean>;
    sendToApprover(text: string): Promise<boolean>;
    safeReply(message: IncomingMessage, text: string): Promise<boolean>;
    markProcessed(message: IncomingMessage): Promise<void>;
    rememberFromMention(message: IncomingMessage, intent: BotIntent, analysis?: string): void;
}
export declare class BotMentionFlow {
    private readonly options;
    constructor(options: BotMentionFlowOptions);
    handle(message: IncomingMessage, signal: AbortSignal): Promise<void>;
    private analyzeBotRequest;
    private sendOwnerDecisionCard;
    private sanitize;
}
