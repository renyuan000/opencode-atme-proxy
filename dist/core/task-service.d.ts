import type { AppConfig } from "./config.js";
import type { AuditLog } from "./audit.js";
import type { ContextService } from "./context-service.js";
import type { Logger } from "./logger.js";
import type { MemoryStore } from "./memory-store.js";
import type { SessionManager, SessionPermission } from "./session-manager.js";
import type { TaskStore } from "./task-store.js";
import type { TaskEventType } from "./task-events.js";
import type { PromptAttachment } from "./opencode.js";
import type { Classification, IncomingMessage, NotificationView, TaskAnalysis, TaskRecord } from "./types.js";
export interface TaskServiceOptions {
    config: AppConfig;
    stateDir: string;
    stateDirFor?(chatId: string): string;
    workspaceDirFor?(chatId: string): string | undefined;
    tasks: TaskStore;
    audit: AuditLog;
    contextService: ContextService;
    sessionManager: SessionManager;
    logger: Logger;
    readOnlyPermission: SessionPermission[];
    conversationIdFor?(platform: string, chatId: string): string;
    loadMedia?(task: TaskRecord): Promise<{
        attachments: PromptAttachment[];
        documents: string[];
    }>;
    memory: MemoryStore;
    resolveProject(chatId: string): Promise<{
        worktree: string;
        resolved: boolean;
        workspace?: boolean;
        workspaceRoot?: string;
        workspaceProjects?: Array<{
            name: string;
            path: string;
            description?: string;
        }>;
        workspaceDocs?: string[];
        writableProjects?: string[];
        coreProjects?: string[];
        referenceProjects?: string[];
    }>;
    projectId(chatId: string): string | undefined;
    chatLabelFor?(chatId: string): Promise<string | undefined>;
    senderLabelFor?(userId: string, messageId?: string): Promise<string | undefined>;
    messageLinkFor?(chatId: string, messageId: string): Promise<string | undefined>;
    startAnalysis(task: TaskRecord): void;
    sendToApprover(text: string): Promise<boolean>;
    sendOwnerNotification?(view: NotificationView): Promise<boolean>;
    sendOwnerNotificationResult?(view: NotificationView): Promise<{
        ok: boolean;
        messageId?: string;
    }>;
    linkTaskMessage?(chatId: string, messageId: string, taskId: string): Promise<void>;
    publishTaskEvent?(input: {
        chatId: string;
        taskId: string;
        type: TaskEventType;
        payload?: Record<string, unknown>;
    }): Promise<unknown>;
    sendApproval(task: TaskRecord, analysis: TaskAnalysis): Promise<void>;
}
export declare class TaskService {
    private readonly options;
    constructor(options: TaskServiceOptions);
    analyzeTask(task: TaskRecord): Promise<void>;
    appendSupplement(task: TaskRecord, message: IncomingMessage): Promise<TaskRecord["state"]>;
    ensureTask(message: IncomingMessage, classification: Classification | undefined, source: TaskRecord["source"], options?: {
        autoAnalyze?: boolean;
    }): Promise<TaskRecord | undefined>;
    private rememberTaskOutcome;
    private buildAnalysis;
    private buildAnalysisInWorktree;
    private verifyAnalysis;
    private analysisDirectory;
    private missingProjectAnalysis;
}
