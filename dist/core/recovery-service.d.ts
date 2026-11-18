import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { PendingStore } from "./pending-store.js";
import type { PlatformAdapter } from "./ports.js";
import type { TaskStore } from "./task-store.js";
import type { IncomingMessage, TaskRecord } from "./types.js";
export interface RecoveryServiceOptions {
    config: AppConfig;
    logger: Logger;
    platform: PlatformAdapter;
    pending: PendingStore;
    tasks: TaskStore;
    dedup: {
        has(key: string): boolean;
    };
    groupIds: Set<string>;
    isMention(message: IncomingMessage): boolean;
    ingest(message: IncomingMessage): Promise<void>;
    ingestBatch(messages: IncomingMessage[]): Promise<void>;
    analyzeTask(task: TaskRecord): Promise<void>;
    track<T>(promise: Promise<T>): Promise<T>;
    sendToOwner(text: string): Promise<boolean>;
}
export declare class RecoveryService {
    private readonly options;
    constructor(options: RecoveryServiceOptions);
    recoverOnStartup(): Promise<void>;
    private pullStartupWindow;
    private resumeOpenTasks;
}
