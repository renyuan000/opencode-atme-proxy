import type { RepoConfig } from "./config.js";
import type { Logger } from "./logger.js";
export interface Worktree {
    path: string;
    branch: string;
    baseCommit: string;
}
export interface CommandResult {
    passed: boolean;
    summary: string;
}
export interface GitExecutorOptions {
    worktreeRoot: string;
    timeoutMs: number;
    logger?: Logger;
}
export declare class GitExecutor {
    private readonly options;
    private readonly logger;
    constructor(options: GitExecutorOptions);
    prepare(repo: RepoConfig, taskId: string): Promise<Worktree>;
    runConfiguredCommands(repo: RepoConfig, worktree: Worktree): Promise<CommandResult>;
    diffStat(worktree: Worktree): Promise<string>;
    commitState(worktree: Worktree): Promise<string>;
    cleanup(worktree: Worktree): Promise<void>;
    private git;
}
