import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { Logger } from "./logger.js";
import type { RepoConfig } from "./config.js";
export interface SessionCreateInput {
    directory: string;
    title: string;
    agent?: string;
    parentID?: string;
    model?: {
        providerID: string;
        modelID: string;
    };
    permission?: Array<{
        permission: string;
        pattern: string;
        action: "allow" | "deny" | "ask";
    }>;
}
export interface SessionInfo {
    id: string;
    title: string;
    directory: string;
    parentID?: string;
    timeArchived?: number;
}
export interface SessionPromptInput extends SessionCreateInput {
    text: string;
    signal?: AbortSignal;
}
export interface OpenCodeBridge {
    createSession(input: SessionCreateInput): Promise<string>;
    prompt(sessionId: string, input: SessionPromptInput): Promise<string>;
    deleteSession(sessionId: string): Promise<void>;
    getClient(): OpencodeClient;
    getInfo?(): {
        baseUrl: string;
        mode: "http" | "injected";
    };
    healthCheck?(): Promise<{
        ok: boolean;
        detail?: string;
    }>;
    getSession?(sessionId: string, directory?: string): Promise<SessionInfo | undefined>;
    archiveSession?(sessionId: string, directory?: string): Promise<void>;
    listChildren?(sessionId: string, directory?: string): Promise<SessionInfo[]>;
}
export declare class HttpOpenCodeBridge implements OpenCodeBridge {
    private readonly options;
    private readonly logger;
    private readonly client;
    constructor(options: {
        baseUrl: string;
        password?: string;
        logger?: Logger;
    });
    getClient(): OpencodeClient;
    getInfo(): {
        baseUrl: string;
        mode: "http" | "injected";
    };
    healthCheck(): Promise<{
        ok: boolean;
        detail?: string;
    }>;
    createSession(input: SessionCreateInput): Promise<string>;
    prompt(sessionId: string, input: SessionPromptInput): Promise<string>;
    getSession(sessionId: string, directory?: string): Promise<SessionInfo | undefined>;
    archiveSession(sessionId: string, directory?: string): Promise<void>;
    listChildren(sessionId: string, directory?: string): Promise<SessionInfo[]>;
    deleteSession(sessionId: string): Promise<void>;
}
export declare class InjectedOpenCodeBridge implements OpenCodeBridge {
    private readonly client;
    private readonly logger;
    constructor(client: OpencodeClient, logger?: Logger);
    getInfo(): {
        baseUrl: string;
        mode: "http" | "injected";
    };
    healthCheck(): Promise<{
        ok: boolean;
        detail?: string;
    }>;
    getClient(): OpencodeClient;
    createSession(input: SessionCreateInput): Promise<string>;
    prompt(sessionId: string, input: SessionPromptInput): Promise<string>;
    getSession(sessionId: string, directory?: string): Promise<SessionInfo | undefined>;
    archiveSession(sessionId: string, directory?: string): Promise<void>;
    listChildren(sessionId: string, directory?: string): Promise<SessionInfo[]>;
    deleteSession(sessionId: string): Promise<void>;
}
export interface ExecutorOptions {
    bridge: OpenCodeBridge;
    repo: RepoConfig;
    worktreeRoot: string;
    timeoutMs: number;
    logger?: Logger;
}
export interface ExecutionResult {
    success: boolean;
    diffStat: string;
    testSummary: string;
    branch: string;
    worktree: string;
    error?: string;
}
export declare function repoById(repos: RepoConfig[], id: string): RepoConfig | undefined;
