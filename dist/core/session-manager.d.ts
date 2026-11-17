import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { OpenCodeBridge } from "./opencode.js";
import type { SessionStore } from "./session-store.js";
export interface SessionPermission {
    permission: string;
    pattern: string;
    action: "allow" | "deny" | "ask";
}
export type WorkerRole = "reply" | "analysis" | "review";
export type ChildRole = WorkerRole | "execution";
export interface WorkerInput {
    platform: string;
    chatId: string;
    directory: string;
    title: string;
    role: WorkerRole;
    agent?: string;
    permission?: SessionPermission[];
    model?: {
        providerID: string;
        modelID: string;
    };
}
export interface ChildInput {
    platform: string;
    chatId: string;
    directory: string;
    title: string;
    role: ChildRole;
    agent?: string;
    permission?: SessionPermission[];
    taskId?: string;
    model?: {
        providerID: string;
        modelID: string;
    };
    signal?: AbortSignal;
}
export interface SessionManagerOptions {
    bridge: OpenCodeBridge;
    sessions: SessionStore;
    config: AppConfig;
    logger: Logger;
    readOnlyPermission: SessionPermission[];
    createChildSession(input: ChildInput): Promise<{
        sessionId: string;
        release: () => void;
    }>;
    finishSession(sessionId: string, title: string, directory: string, purpose: string): Promise<void>;
}
export declare class SessionManager {
    private readonly options;
    private readonly coordinatorLocks;
    private readonly workerLocks;
    constructor(options: SessionManagerOptions);
    coordinatorSession(platform: string, chatId: string, directory: string, title: string): Promise<string>;
    createGroupSession(platform: string, chatId: string, directory: string): Promise<string>;
    createWorkerSession(input: WorkerInput): Promise<string>;
    runWorker(input: WorkerInput, promptText: string, signal?: AbortSignal): Promise<string>;
}
