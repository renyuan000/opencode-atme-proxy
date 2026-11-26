import type { TaskRecord } from "./types.js";
import type { Logger } from "./logger.js";
import type { TaskStateDb } from "./task-state-db.js";
export declare class TaskStore {
    private readonly dir;
    private index;
    private readonly logger;
    private indexDirty;
    private readonly db?;
    private readonly state?;
    constructor(dir: string, logger?: Logger, dbPath?: string, state?: TaskStateDb);
    private taskPath;
    private indexPath;
    load(): Promise<void>;
    get(taskId: string): Promise<TaskRecord | undefined>;
    findByDedupKey(dedupKey: string): string | undefined;
    findByMessageId(messageId: string): Promise<TaskRecord | undefined>;
    list(): Promise<TaskRecord[]>;
    forgetTask(taskId: string): void;
    redactMessage(messageId: string): Promise<void>;
    saveWithLinks(task: TaskRecord, messageIds: string[]): Promise<boolean>;
    save(task: TaskRecord): Promise<void>;
    flush(): Promise<void>;
    close(): Promise<void>;
    private migrateLegacyToState;
    private migrateLegacyToDb;
}
