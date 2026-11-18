import type { AppConfig } from "./config.js";
import type { AuditLog } from "./audit.js";
import type { ContextService } from "./context-service.js";
import type { Logger } from "./logger.js";
import type { SessionManager, SessionPermission } from "./session-manager.js";
import type { TaskStore } from "./task-store.js";
import type { TaskAnalysis, TaskRecord } from "./types.js";
export interface TaskServiceOptions {
    config: AppConfig;
    stateDir: string;
    tasks: TaskStore;
    audit: AuditLog;
    contextService: ContextService;
    sessionManager: SessionManager;
    logger: Logger;
    readOnlyPermission: SessionPermission[];
    resolveProject(chatId: string): Promise<{
        worktree: string;
        resolved: boolean;
    }>;
    rememberOutcome(task: TaskRecord, analysis: TaskAnalysis): void;
    sendToApprover(text: string): Promise<boolean>;
    sendApproval(task: TaskRecord, analysis: TaskAnalysis): Promise<void>;
}
export declare class TaskService {
    private readonly options;
    constructor(options: TaskServiceOptions);
    analyzeTask(task: TaskRecord): Promise<void>;
    private buildAnalysis;
    private buildAnalysisInWorktree;
    private verifyAnalysis;
    private analysisDirectory;
}
