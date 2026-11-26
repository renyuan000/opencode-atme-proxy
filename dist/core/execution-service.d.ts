import type { AppConfig } from "./config.js";
import type { ApprovalStore } from "./approval-store.js";
import type { AuditLog } from "./audit.js";
import type { Logger } from "./logger.js";
import type { OpenCodeBridge } from "./opencode.js";
import type { SessionManager, SessionPermission } from "./session-manager.js";
import type { TaskStore } from "./task-store.js";
import type { TaskAnalysis, TaskRecord } from "./types.js";
import type { GitExecutor } from "./executor.js";
import type { TaskRun } from "./task-state-db.js";
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
    executionPermissionFor?(input: {
        writableProjects?: string[];
        referenceProjects?: string[];
    }): SessionPermission[];
    readOnlyPermission: SessionPermission[];
    conversationIdFor?(platform: string, chatId: string): string;
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
            defaultBranch?: string;
            testCommand?: string[][];
            lintCommand?: string[][];
        }>;
        workspaceDocs?: string[];
        writableProjects?: string[];
        referenceProjects?: string[];
    }>;
    sendToApprover(text: string): Promise<boolean>;
    sendToOwner(text: string): Promise<boolean>;
    startTaskRun?(input: {
        taskId: string;
        chatId: string;
        role: string;
        stage: string;
    }): Promise<TaskRun>;
    attachTaskRunSession?(runId: string, sessionId: string, chatId: string): Promise<unknown>;
    finishTaskRun?(runId: string, chatId: string, status: string): Promise<unknown>;
    touchTaskRun?(runId: string, chatId: string): Promise<unknown>;
}
export declare class ExecutionService {
    private readonly options;
    private readonly slots;
    private readonly runHeartbeats;
    constructor(options: ExecutionServiceOptions);
    private startRun;
    private attachRun;
    private finishRun;
    private promptWithTimeout;
    executeTask(task: TaskRecord, planHash: string): Promise<void>;
    private executeInWorkspace;
    private executeInWorktree;
    private reviewExecution;
    private runOpenCodeExecution;
    private workspaceExecutionPrompt;
    private executionPrompt;
}
