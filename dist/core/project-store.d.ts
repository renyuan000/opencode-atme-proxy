import type { Logger } from "./logger.js";
export interface BoundProject {
    projectId: string;
    worktree: string;
    name?: string;
    reason: string;
    boundAt: number;
}
export declare class ProjectStore {
    private readonly file;
    private chats;
    private dirty;
    private readonly logger;
    constructor(file: string, logger?: Logger);
    load(): Promise<void>;
    get(chatId: string): BoundProject | undefined;
    set(chatId: string, project: BoundProject): void;
    delete(chatId: string): void;
    flush(): Promise<void>;
}
