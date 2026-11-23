import type { Logger } from "./logger.js";
import { type ChatContext, type ChatContextStoreOptions, type ContextMessage } from "./chat-context.js";
import { type GroupSummary } from "./group-context.js";
import { type MemoryInput, type MemoryQuery, type MemoryRecord, type MemoryKind } from "./memory-store.js";
import { EvidenceStore, type EvidenceRecord } from "./evidence-store.js";
import { TaskStore } from "./task-store.js";
import { type PendingCard } from "./pending-store.js";
import { type SessionKind, type SessionRecord } from "./session-store.js";
import { type SentReplyRecord } from "./sent-reply-store.js";
import { type CursorRecord } from "./cursor.js";
import { type BoundProject } from "./project-store.js";
import { ApprovalStore } from "./approval-store.js";
import { AuditLog } from "./audit.js";
export declare function groupDirName(chatId: string, name?: string): string;
export declare function shortGroupId(chatId: string): string;
export interface GroupStateInfo {
    chatId: string;
    name: string;
    dirName: string;
    dir: string;
}
export declare class GroupStateLayout {
    private readonly root;
    private readonly byChat;
    private readonly byDir;
    private readonly logger;
    constructor(root: string, logger?: Logger);
    load(): Promise<void>;
    ensure(chatId: string, name?: string): Promise<GroupStateInfo>;
    private writeGroupJson;
    dirFor(chatId: string): string;
    rootPath(): string;
    unassignedPath(): string;
    all(): GroupStateInfo[];
}
export declare class ScopedChatContext {
    private readonly layout;
    private readonly options;
    private readonly stores;
    constructor(layout: GroupStateLayout, options: Omit<ChatContextStoreOptions, "file">);
    load(): Promise<void>;
    private store;
    get(chatKey: string): ChatContext | undefined;
    append(chatKey: string, message: ContextMessage, meta?: Pick<ChatContext, "platform" | "chatId" | "chatName" | "conversationId">): void;
    bindProject(chatKey: string, projectId: string, worktree: string): void;
    recent(chatKey: string, limit: number, excludeMessageId?: string): ContextMessage[];
    find(chatKey: string, messageIds: string[]): ContextMessage[];
    prune(): void;
    flush(): Promise<void>;
}
export declare class ScopedGroupContext {
    private readonly layout;
    private readonly stores;
    constructor(layout: GroupStateLayout, logger?: Logger);
    private readonly logger?;
    load(): Promise<void>;
    private store;
    get(chatId: string): GroupSummary | undefined;
    set(chatId: string, summary: GroupSummary): void;
    size(): number;
    list(): GroupSummary[];
    flush(): Promise<void>;
}
export declare class ScopedMemory {
    private readonly layout;
    private readonly options;
    private readonly stores;
    constructor(layout: GroupStateLayout, options: {
        maxEntries: number;
        ttlMs: number;
        pinnedKinds: MemoryKind[];
        logger?: Logger;
    });
    load(): Promise<void>;
    migrateShards(): Promise<void>;
    private store;
    upsert(input: MemoryInput): MemoryRecord;
    query(input: MemoryQuery): MemoryRecord[];
    get(id: string): MemoryRecord | undefined;
    delete(id: string): boolean;
    flush(): Promise<void>;
}
export declare class ScopedEvidence {
    private readonly layout;
    private readonly options;
    private readonly stores;
    constructor(layout: GroupStateLayout, options: Omit<ConstructorParameters<typeof EvidenceStore>[0], "dir">);
    private store;
    append(record: EvidenceRecord): void;
    search(input: {
        chatId: string;
        terms: string[];
        days?: number;
        limit?: number;
    }): EvidenceRecord[];
    findByMessageId(input: {
        chatId: string;
        messageId: string;
        days?: number;
    }): EvidenceRecord | undefined;
    prune(): void;
}
export declare class ScopedTasks {
    private readonly layout;
    private readonly logger?;
    private readonly stores;
    constructor(layout: GroupStateLayout, logger?: Logger | undefined);
    load(): Promise<void>;
    private store;
    get(taskId: string): Promise<import("./types.js").TaskRecord | undefined>;
    findByDedupKey(dedupKey: string): string | undefined;
    findByMessageId(messageId: string): Promise<import("./types.js").TaskRecord | undefined>;
    list(): Promise<import("./types.js").TaskRecord[]>;
    save(task: Parameters<TaskStore["save"]>[0]): Promise<void>;
    flush(): Promise<void>;
    close(): Promise<void>;
}
export declare class ScopedPending {
    private readonly layout;
    private readonly logger?;
    private readonly stores;
    constructor(layout: GroupStateLayout, logger?: Logger | undefined);
    load(): Promise<void>;
    private store;
    get(key: string): PendingCard | undefined;
    findForTask(taskId: string): PendingCard | undefined;
    set(key: string, card: PendingCard): void;
    delete(key: string): void;
    deleteForTask(taskId: string): void;
    snapshot(): Array<[string, PendingCard]>;
    flush(): Promise<void>;
}
export declare class ScopedSessions {
    private readonly layout;
    private readonly logger?;
    private readonly stores;
    constructor(layout: GroupStateLayout, logger?: Logger | undefined);
    load(): Promise<void>;
    private store;
    get(key: string): SessionRecord | undefined;
    set(key: string, sessionId: string, directory: string, meta?: {
        kind?: SessionKind;
        taskId?: string;
        createdAt?: number;
        archivedAt?: number;
        chatId?: string;
    }): void;
    list(kind?: SessionKind): Array<[string, SessionRecord]>;
    delete(key: string): void;
    findByTask(taskId: string, kind?: SessionKind): Array<[string, SessionRecord]>;
    flush(): Promise<void>;
}
export declare class ScopedSentReplies {
    private readonly layout;
    private readonly ttlMs;
    private readonly maxEntries;
    private readonly logger?;
    private readonly stores;
    constructor(layout: GroupStateLayout, ttlMs: number, maxEntries: number, logger?: Logger | undefined);
    load(): Promise<void>;
    private store;
    add(input: Omit<SentReplyRecord, "id" | "status">): Promise<SentReplyRecord>;
    list(limit?: number): SentReplyRecord[];
    listRecallable(limit?: number, now?: number): SentReplyRecord[];
    get(id: string): SentReplyRecord | undefined;
    hasSource(sourceMessageId: string): boolean;
    listBySource(sourceMessageId: string): SentReplyRecord[];
    markRecalled(id: string, at?: number): Promise<boolean>;
    flush(): Promise<void>;
}
export declare class ScopedCursors {
    private readonly layout;
    private readonly logger?;
    private readonly stores;
    constructor(layout: GroupStateLayout, logger?: Logger | undefined);
    load(): Promise<void>;
    private store;
    get(chatId: string): number | undefined;
    record(chatId: string): CursorRecord | undefined;
    set(chatId: string, lastEndTime: number, last?: {
        messageId?: string;
        messageTime?: number;
    }): void;
    flush(): Promise<void>;
}
export declare class ScopedProjects {
    private readonly layout;
    private readonly logger?;
    private readonly stores;
    constructor(layout: GroupStateLayout, logger?: Logger | undefined);
    load(): Promise<void>;
    private store;
    get(chatId: string): BoundProject | undefined;
    set(chatId: string, project: BoundProject): void;
    delete(chatId: string): void;
    flush(): Promise<void>;
}
export declare class ScopedApprovals {
    private readonly layout;
    private readonly chatForTask;
    private readonly stores;
    constructor(layout: GroupStateLayout, chatForTask: (taskId: string) => Promise<string | undefined>);
    private storeForTask;
    list(taskId: string): Promise<import("./types.js").ApprovalRecord[]>;
    latest(taskId: string, kind: Parameters<ApprovalStore["latest"]>[1]): Promise<import("./types.js").ApprovalRecord | undefined>;
    append(record: Parameters<ApprovalStore["append"]>[0]): Promise<void>;
    replaceLatest(record: Parameters<ApprovalStore["replaceLatest"]>[0]): Promise<void>;
}
export declare class ScopedDedup {
    private readonly layout;
    private readonly filename;
    private readonly ttlMs;
    private readonly maxEntries;
    private readonly logger?;
    private readonly stores;
    constructor(layout: GroupStateLayout, filename: string, ttlMs: number, maxEntries: number, logger?: Logger | undefined);
    load(): Promise<void>;
    private store;
    has(key: string, chatId?: string): boolean;
    add(key: string, chatId?: string): void;
    delete(key: string, chatId?: string): void;
    flush(): Promise<void>;
    close(): Promise<void>;
}
export declare class ScopedAudit {
    private readonly layout;
    private readonly chatForTask;
    private readonly stores;
    constructor(layout: GroupStateLayout, chatForTask: (taskId: string) => Promise<string | undefined>);
    private storeFor;
    append(input: {
        actor: Parameters<AuditLog["append"]>[0]["actor"];
        action: string;
        taskId?: string;
        details?: Record<string, unknown>;
    }): Promise<import("./types.js").AuditEvent>;
}
