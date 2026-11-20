import type { Logger } from "./logger.js";
export type JobStatus = "queued" | "running" | "waiting_owner" | "done" | "failed" | "dead";
export type JobType = "chat" | "file_analyze" | "scan" | "task_analysis" | "execution";
export interface JobRecord {
    id: string;
    chatId: string;
    messageId: string;
    type: JobType;
    priority: number;
    status: JobStatus;
    attempts: number;
    createdAt: number;
    updatedAt: number;
    error?: string;
}
export declare class JobStore {
    private readonly dir;
    private readonly logger;
    private readonly jobs;
    private ack;
    constructor(dir: string, logger?: Logger);
    private taskDir;
    load(): Promise<void>;
    get(id: string): JobRecord | undefined;
    list(status?: JobStatus): JobRecord[];
    save(record: JobRecord): Promise<void>;
    create(input: Omit<JobRecord, "createdAt" | "updatedAt" | "attempts">): Promise<JobRecord>;
    update(id: string, patch: Partial<Pick<JobRecord, "status" | "priority" | "error" | "attempts">>): Promise<JobRecord | undefined>;
    private flushOne;
    flush(): Promise<void>;
}
