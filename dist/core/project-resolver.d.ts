import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { Logger } from "./logger.js";
export interface ProjectCandidate {
    id: string;
    worktree: string;
    name?: string;
    vcs: boolean;
    updatedAt: number;
}
export interface ProjectSelection {
    project: ProjectCandidate;
    reason: string;
    score: number;
}
export interface ProjectResolverOptions {
    client: OpencodeClient;
    logger?: Logger;
    allowlist: string[];
    explicitProjectId?: string;
    explicitWorktree?: string;
    fallbackWorktree?: string;
    recentSessions?: number;
    maxAgeDays?: number;
}
export declare class ProjectResolver {
    private readonly options;
    private readonly logger;
    constructor(options: ProjectResolverOptions);
    resolve(): Promise<ProjectSelection | undefined>;
    resolveWorktree(): Promise<string | undefined>;
    private maxAgeDays;
    private isAllowed;
    private listProjects;
    private scoreByRecentSessions;
}
export declare function isActiveProject(project: ProjectCandidate): boolean;
export declare function isInside(parent: string, child: string): boolean;
export declare function recencyScore(updatedAt: number, maxAgeDays: number): number;
export declare function isRecent(updatedAt: number, maxAgeDays: number): boolean;
export declare function candidateLogFields(selection: ProjectSelection | undefined): Record<string, unknown>;
