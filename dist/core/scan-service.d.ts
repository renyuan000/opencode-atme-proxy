import type { AppConfig } from "./config.js";
import type { ChatContextStore } from "./chat-context.js";
import type { ConcurrentDispatcher } from "./dispatcher.js";
import type { IntentService } from "./intent-service.js";
import type { Logger } from "./logger.js";
import type { RelevanceService } from "./relevance.js";
import type { TaskService } from "./task-service.js";
import type { IncomingMessage } from "./types.js";
export interface ScanServiceOptions {
    config: AppConfig;
    logger: Logger;
    relevance(): RelevanceService;
    dispatcher: ConcurrentDispatcher;
    chatContext: ChatContextStore;
    intentService: IntentService;
    taskService: TaskService;
    filterEnabled: boolean;
    groupIds: Set<string>;
    dedup: {
        has(key: string): boolean;
    };
    activeMessageIds: Set<string>;
    isMention(message: IncomingMessage): boolean;
    onMessage(message: IncomingMessage, wait: boolean): Promise<void>;
    markProcessed(message: IncomingMessage): Promise<void>;
    sendToApprover(text: string): Promise<boolean>;
    sendToOwner(text: string): Promise<boolean>;
}
export declare class ScanService {
    private readonly options;
    constructor(options: ScanServiceOptions);
    handlePolledBatch(messages: IncomingMessage[]): Promise<void>;
    handleGroupScan(message: IncomingMessage, signal: AbortSignal): Promise<void>;
    private handlePolledBatchJob;
    private digestWithoutFilter;
    private sendOwnerDigest;
    private appendContextForScan;
}
