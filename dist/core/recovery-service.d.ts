import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { PendingStore } from "./pending-store.js";
import type { PlatformAdapter } from "./ports.js";
import type { TaskStore } from "./task-store.js";
import type { IncomingMessage, NotificationView, TaskRecord } from "./types.js";
export interface RecoveryServiceOptions {
    config: AppConfig;
    logger: Logger;
    platform: PlatformAdapter;
    pending: PendingStore;
    tasks: TaskStore;
    dedup: {
        has(key: string, chatId?: string): boolean;
        delete(key: string, chatId?: string): void;
    };
    historyMentions: {
        has(key: string, chatId?: string): boolean;
        add(key: string, chatId?: string): void;
        flush(): Promise<void>;
    };
    sentReplies: {
        hasSource(messageId: string): boolean;
    };
    groupIds: Set<string>;
    lastCursor?(platform: string, chatId: string): number | undefined;
    recordCursor(chatId: string, endTime: number): Promise<void>;
    isMention(message: IncomingMessage): boolean;
    ingest(message: IncomingMessage, force?: boolean): Promise<void>;
    ingestBatch(messages: IncomingMessage[]): Promise<void>;
    analyzeTask(task: TaskRecord): Promise<void>;
    track<T>(promise: Promise<T>): Promise<T>;
    sendToOwner(text: string): Promise<boolean>;
    sendOwnerNotification?(view: NotificationView): Promise<boolean>;
    describeTask?(task: TaskRecord): Promise<{
        chatLabel: string;
        senderLabel: string;
    }>;
}
export declare class RecoveryService {
    private readonly options;
    constructor(options: RecoveryServiceOptions);
    recoverOnStartup(): Promise<void>;
    private pullStartupWindow;
    private sendPendingTaskNotices;
    private sendTaskNotice;
    private resumeOpenTasks;
}
