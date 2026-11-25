import type { AppConfig } from "./config.js";
import type { ChatContextStore } from "./chat-context.js";
import type { EvidenceStore } from "./evidence-store.js";
import type { GroupContextStore } from "./group-context.js";
import type { MemoryStore } from "./memory-store.js";
import type { TaskStore } from "./task-store.js";
import type { IncomingMessage, TaskRecord } from "./types.js";
export interface ContextServiceOptions {
    config: AppConfig;
    chatContext: ChatContextStore;
    memory: MemoryStore;
    tasks: TaskStore;
    groupContext: GroupContextStore;
    evidence: EvidenceStore;
}
export interface AnalysisContext {
    sourceMessages: string[];
    supplements: string[];
    recentContext: string[];
    pinned: string[];
    memory: string[];
    openTasks: string[];
    summary: string;
    corpus: string;
}
export declare class ContextService {
    private readonly options;
    constructor(options: ContextServiceOptions);
    memoryBlock(platform: string, chatId: string | undefined, text: string): string;
    summaryText(platform: string, chatId: string): string;
    quotedContext(message: IncomingMessage): string[];
    evidenceRecall(message: IncomingMessage): string[];
    ownerOverview(message: IncomingMessage): Promise<string>;
    analysisContext(task: TaskRecord): Promise<AnalysisContext>;
}
