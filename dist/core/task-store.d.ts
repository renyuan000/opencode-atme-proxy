import type { TaskRecord } from "./types.js";
import type { Logger } from "./logger.js";
export declare class TaskStore {
    private readonly dir;
    private index;
    private readonly logger;
    private indexDirty;
    constructor(dir: string, logger?: Logger);
    private taskPath;
    private indexPath;
    load(): Promise<void>;
    get(taskId: string): Promise<TaskRecord | undefined>;
    findByDedupKey(dedupKey: string): string | undefined;
    findByMessageId(messageId: string): Promise<TaskRecord | undefined>;
    list(): Promise<TaskRecord[]>;
    save(task: TaskRecord): Promise<void>;
    flush(): Promise<void>;
    close(): Promise<void>;
}
