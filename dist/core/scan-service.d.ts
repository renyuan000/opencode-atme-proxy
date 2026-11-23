import type { AppConfig } from "./config.js";
import type { ChatContextStore } from "./chat-context.js";
import type { ConcurrentDispatcher } from "./dispatcher.js";
import type { IntentService } from "./intent-service.js";
import type { Logger } from "./logger.js";
import type { PlatformAdapter } from "./ports.js";
import type { RelevanceService } from "./relevance.js";
import type { TaskService } from "./task-service.js";
import type { IncomingMessage } from "./types.js";
export interface ScanServiceOptions {
    config: AppConfig;
    logger: Logger;
    relevance(): RelevanceService;
    platform: PlatformAdapter;
    dispatcher: ConcurrentDispatcher;
    chatContext: ChatContextStore;
    intentService: IntentService;
    taskService: TaskService;
    filterEnabled: boolean;
    groupIds: Set<string>;
    dedup: {
        has(key: string, chatId?: string): boolean;
    };
    activeMessageIds: Set<string>;
    ownerOpenId(): string | undefined;
    conversationIdFor?(message: IncomingMessage): string;
    isMention(message: IncomingMessage): boolean;
    isFileRelevant?(message: IncomingMessage, fileName: string, content?: string): boolean | undefined;
    onMessage(message: IncomingMessage, wait: boolean): Promise<void>;
    markProcessed(message: IncomingMessage): Promise<void>;
    sendToApprover(text: string): Promise<boolean>;
    sendToOwner(text: string): Promise<boolean>;
    analyzeFile?(message: IncomingMessage, signal: AbortSignal): Promise<string | undefined>;
    forwardToOwner?(messageId: string): Promise<boolean>;
}
export declare class ScanService {
    private readonly options;
    constructor(options: ScanServiceOptions);
    handlePolledBatch(messages: IncomingMessage[]): Promise<void>;
    private skipIrrelevantFile;
    private analyzeFile;
    private enrichFile;
    private enrichFiles;
    handleGroupScan(message: IncomingMessage, signal: AbortSignal): Promise<void>;
    private handlePolledBatchJob;
    private digestWithoutFilter;
    private sendOwnerDigest;
    private resolveSenderLabel;
    private appendContextForScan;
}
