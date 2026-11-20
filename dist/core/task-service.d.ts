import type { AppConfig } from "./config.js";
import type { AuditLog } from "./audit.js";
import type { ContextService } from "./context-service.js";
import type { Logger } from "./logger.js";
import type { MemoryStore } from "./memory-store.js";
import type { SessionManager, SessionPermission } from "./session-manager.js";
import type { TaskStore } from "./task-store.js";
import type { Classification, IncomingMessage, TaskAnalysis, TaskRecord } from "./types.js";
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
    }>;
    projectId(chatId: string): string | undefined;
    startAnalysis(task: TaskRecord): void;
    sendToApprover(text: string): Promise<boolean>;
    sendApproval(task: TaskRecord, analysis: TaskAnalysis): Promise<void>;
}
export declare class TaskService {
    private readonly options;
    constructor(options: TaskServiceOptions);
    analyzeTask(task: TaskRecord): Promise<void>;
    ensureTask(message: IncomingMessage, classification: Classification | undefined, source: TaskRecord["source"]): Promise<TaskRecord | undefined>;
    private rememberTaskOutcome;
    private buildAnalysis;
    private buildAnalysisInWorktree;
    private verifyAnalysis;
    private analysisDirectory;
    private missingProjectAnalysis;
}
