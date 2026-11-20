import type { AppConfig } from "./config.js";
import type { ApprovalStore } from "./approval-store.js";
import type { AuditLog } from "./audit.js";
import type { Logger } from "./logger.js";
import type { OpenCodeBridge } from "./opencode.js";
import type { SessionManager, SessionPermission } from "./session-manager.js";
import type { TaskStore } from "./task-store.js";
import type { TaskAnalysis, TaskRecord } from "./types.js";
import type { GitExecutor } from "./executor.js";
export interface ExecutionServiceOptions {
    config: AppConfig;
    stateDir: string;
    stateDirFor?(chatId: string): string;
    workspaceDirFor?(chatId: string): string | undefined;
    tasks: TaskStore;
    approvals: ApprovalStore;
    audit: AuditLog;
    executor: GitExecutor;
    bridge: OpenCodeBridge;
    sessionManager: SessionManager;
    logger: Logger;
    executionPermission: SessionPermission[];
    readOnlyPermission: SessionPermission[];
    latestAnalysis(taskId: string): Promise<TaskAnalysis | undefined>;
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
    sendToApprover(text: string): Promise<boolean>;
    sendToOwner(text: string): Promise<boolean>;
}
export declare class ExecutionService {
    private readonly options;
    private readonly slots;
    constructor(options: ExecutionServiceOptions);
    executeTask(task: TaskRecord, planHash: string): Promise<void>;
    private executeInWorktree;
    private reviewExecution;
    private runOpenCodeExecution;
    private executionPrompt;
}
