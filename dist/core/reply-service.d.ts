import type { AppConfig } from "./config.js";
import type { AuditLog } from "./audit.js";
import type { ChatContextStore } from "./chat-context.js";
import type { ContextService } from "./context-service.js";
import type { LlmClient } from "./relevance.js";
import type { Logger } from "./logger.js";
import type { PendingStore } from "./pending-store.js";
import type { PlatformAdapter } from "./ports.js";
import type { TokenBucket } from "./rate-limit.js";
import type { SessionManager, SessionPermission } from "./session-manager.js";
import type { TaskStore } from "./task-store.js";
import type { Classification, IncomingMessage, TaskRecord } from "./types.js";
import type { ReplyDepth, ReplyStyle, ReplyStyleOptions } from "./reply-style.js";
export interface ReplyServiceOptions {
    config: AppConfig;
    contextService: ContextService;
    chatContext: ChatContextStore;
    sessionManager: SessionManager;
    tasks: TaskStore;
    pending: PendingStore;
    audit: AuditLog;
    platform: PlatformAdapter;
    sendLimiter: TokenBucket;
    llm: LlmClient;
    logger: Logger;
    replyOptions: ReplyStyleOptions;
    model?: {
        providerID: string;
        modelID: string;
    };
    readOnlyPermission: SessionPermission[];
    webPermission?: SessionPermission[];
    ownerOpenId(): string | undefined;
    resolveProject(chatId: string): Promise<{
        worktree: string;
        resolved: boolean;
        secondaryWorktrees?: string[];
        coreProjects?: string[];
        referenceProjects?: string[];
    }>;
    refreshSummary(platform: string, chatId: string): Promise<void>;
}
export declare class ReplyService {
    private readonly options;
    constructor(options: ReplyServiceOptions);
    shouldReplyToMention(message: IncomingMessage, classification: Classification | undefined): Promise<{
        reply: boolean;
        reason: string;
    }>;
    createReplyTask(message: IncomingMessage, classification: Classification | undefined): Promise<TaskRecord>;
    sendReplyApproval(task: TaskRecord, message: IncomingMessage, draftSource?: IncomingMessage, depth?: ReplyDepth): Promise<void>;
    enrichWithQuoted(message: IncomingMessage): Promise<{
        message: IncomingMessage;
        found: boolean;
    }>;
    draft(message: IncomingMessage, style: ReplyStyle, signal: AbortSignal, depth?: ReplyDepth): Promise<string>;
    private runReplyWorker;
    private loadImageText;
    private loadRecentHistory;
    private loadQuotedChain;
    private loadRecentDocuments;
    private loadLinkedDocuments;
    private loadImages;
}
