import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "./logger.js";
import { createLogger } from "./logger.js";
import { ChatContextStore, type ChatContext, type ChatContextStoreOptions, type ContextMessage } from "./chat-context.js";
import { GroupContextStore, type GroupSummary } from "./group-context.js";
import { MemoryStore, type MemoryInput, type MemoryQuery, type MemoryRecord, type MemoryKind } from "./memory-store.js";
import { EvidenceStore, type EvidenceRecord } from "./evidence-store.js";
import { TaskStore } from "./task-store.js";
import { PendingStore, type PendingCard } from "./pending-store.js";
import { SessionStore, type SessionKind, type SessionRecord } from "./session-store.js";
import { SentReplyStore, type SentReplyRecord } from "./sent-reply-store.js";
import { CursorStore, type CursorRecord } from "./cursor.js";
import { ProjectStore, type BoundProject } from "./project-store.js";
import { ApprovalStore } from "./approval-store.js";
import { DedupStore } from "./dedup.js";
import { AuditLog } from "./audit.js";
import { readJsonFile } from "./util.js";

const UNSAFE = /[/\\:*?"<>|]/g;

export function groupDirName(chatId: string, name?: string): string {
  const display = name || (chatId.startsWith("oc_b0143a44") ? "私聊" : `群_${shortId(chatId)}`);
  return `${sanitize(display)}__${shortId(chatId)}`;
}

function sanitize(value: string): string {
  return (value.replace(UNSAFE, "_").trim() || "群").slice(0, 40);
}

export function shortGroupId(chatId: string): string {
  const id = chatId.split(":").pop() ?? chatId;
  return id.slice(0, 11);
}

function shortId(chatId: string): string {
  const id = chatId.split(":").pop() ?? chatId;
  return id.slice(0, 11);
}

function chatIdOf(key: string): string {
  return key.split(":").pop() ?? key;
}

export interface GroupStateInfo {
  chatId: string;
  name: string;
  dirName: string;
  dir: string;
  conversationId?: string;
}

export class GroupStateLayout {
  private readonly byChat = new Map<string, GroupStateInfo>();
  private readonly byDir = new Map<string, GroupStateInfo>();
  private readonly logger: Logger;

  constructor(
    private readonly root: string,
    logger?: Logger,
  ) {
    this.logger = logger ?? createLogger({ scope: "group-state" });
  }

  async load(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    let entries: string[] = [];
    try {
      entries = await readdir(this.root);
    } catch {
      return;
    }
    for (const dirName of entries) {
      if (dirName.startsWith("_")) continue;
      const dir = join(this.root, dirName);
      try {
        const data = await readJsonFile<{
          chatId?: string;
          name?: string;
          dirName?: string;
          conversationId?: string;
        }>(join(dir, "group.json"), {});
        if (!data.chatId) continue;
        const info: GroupStateInfo = {
          chatId: data.chatId,
          name: data.name ?? dirName.split("__")[0] ?? dirName,
          dirName: data.dirName ?? dirName,
          dir,
          ...(typeof data.conversationId === "string"
            ? { conversationId: data.conversationId }
            : {}),
        };
        this.byChat.set(info.chatId, info);
        this.byDir.set(info.dirName, info);
      } catch {
        continue;
      }
    }
    this.logger.info("group state layout loaded", { groups: this.byChat.size });
  }

  async ensure(
    chatId: string,
    name?: string,
    options?: { conversationId?: string },
  ): Promise<GroupStateInfo> {
    const existing = this.byChat.get(chatId);
    if (existing) {
      let changed = false;
      if (name && name !== existing.name) {
        existing.name = name;
        changed = true;
      }
      if (options?.conversationId && existing.conversationId !== options.conversationId) {
        existing.conversationId = options.conversationId;
        changed = true;
      }
      if (changed) await this.writeGroupJson(existing);
      return existing;
    }
    const displayName = name || (chatId.startsWith("oc_b0143a44") ? "私聊" : `群_${shortId(chatId)}`);
    let dirName = `${sanitize(displayName)}__${shortId(chatId)}`;
    let info = this.byDir.get(dirName);
    if (!info) {
      const dir = join(this.root, dirName);
      await mkdir(dir, { recursive: true });
      info = {
        chatId,
        name: displayName,
        dirName,
        dir,
        ...(options?.conversationId ? { conversationId: options.conversationId } : {}),
      };
      this.byChat.set(chatId, info);
      this.byDir.set(dirName, info);
      await this.writeGroupJson(info);
    } else if (info.chatId !== chatId) {
      dirName = `${sanitize(displayName)}__${shortId(chatId)}-${shortId(chatId).slice(-3)}`;
      const dir = join(this.root, dirName);
      await mkdir(dir, { recursive: true });
      info = {
        chatId,
        name: displayName,
        dirName,
        dir,
        ...(options?.conversationId ? { conversationId: options.conversationId } : {}),
      };
      this.byChat.set(chatId, info);
      this.byDir.set(dirName, info);
      await this.writeGroupJson(info);
    }
    return info;
  }

  private async writeGroupJson(info: GroupStateInfo): Promise<void> {
    await mkdir(info.dir, { recursive: true });
    const path = join(info.dir, "group.json");
    const previous = await readFile(path, "utf8")
      .then((raw) => JSON.parse(raw) as Record<string, unknown>)
      .catch(() => undefined);
    const body = {
      ...(previous ?? {}),
      groupKey: `feishu:${info.chatId}`,
      chatId: info.chatId,
      name: info.name,
      ...(info.conversationId ? { conversationId: info.conversationId } : {}),
      shortId: shortId(info.chatId),
      dirName: info.dirName,
      createdAt: previous?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      project: previous?.project ?? null,
    };
    const { writeJsonAtomic } = await import("./util.js");
    await writeJsonAtomic(path, body);
  }

  dirFor(chatId: string): string {
    return this.byChat.get(chatId)?.dir ?? join(this.root, `群_${shortId(chatId)}`);
  }

  conversationIdFor(chatId: string): string | undefined {
    return this.byChat.get(chatId)?.conversationId;
  }

  rootPath(): string {
    return this.root;
  }

  unassignedPath(): string {
    return join(this.root, "_unassigned");
  }

  all(): GroupStateInfo[] {
    return [...this.byChat.values()];
  }
}

export class ScopedChatContext {
  private readonly stores = new Map<string, ChatContextStore>();

  constructor(
    private readonly layout: GroupStateLayout,
    private readonly options: Omit<ChatContextStoreOptions, "file">,
  ) {}

  async load(): Promise<void> {
    for (const info of this.layout.all()) await this.store(info.chatId).load();
  }

  private store(chatId: string): ChatContextStore {
    const existing = this.stores.get(chatId);
    if (existing) return existing;
    const store = new ChatContextStore({
      ...this.options,
      file: join(this.layout.dirFor(chatId), "chat-context.json"),
    });
    this.stores.set(chatId, store);
    return store;
  }

  private normalizedKey(chatKey: string): string {
    return this.layout.conversationIdFor(chatIdOf(chatKey)) ?? chatKey;
  }

  private keys(chatKey: string): string[] {
    const normalized = this.normalizedKey(chatKey);
    return normalized === chatKey ? [chatKey] : [normalized, chatKey];
  }

  get(chatKey: string): ChatContext | undefined {
    const store = this.store(chatIdOf(chatKey));
    for (const key of this.keys(chatKey)) {
      const context = store.get(key);
      if (context) return context;
    }
    return undefined;
  }

  append(chatKey: string, message: ContextMessage, meta?: Pick<ChatContext, "platform" | "chatId" | "chatName" | "conversationId">): void {
    const key = this.normalizedKey(chatKey);
    this.store(chatIdOf(key)).append(key, message, meta);
  }

  redact(chatKey: string, messageId: string): boolean {
    return this.store(chatIdOf(chatKey)).redact(chatKey, messageId);
  }

  bindProject(chatKey: string, projectId: string, worktree: string): void {
    const key = this.normalizedKey(chatKey);
    this.store(chatIdOf(key)).bindProject(key, projectId, worktree);
  }

  recent(chatKey: string, limit: number, excludeMessageId?: string): ContextMessage[] {
    const store = this.store(chatIdOf(chatKey));
    const messages = this.keys(chatKey).flatMap((key) =>
      store.recent(key, limit, excludeMessageId),
    );
    if (this.keys(chatKey).length === 1) return messages.slice(-limit);
    const byId = new Map<string, ContextMessage>();
    for (const message of messages) byId.set(message.messageId, message);
    return [...byId.values()]
      .sort((a, b) => a.at - b.at)
      .slice(-limit);
  }

  find(chatKey: string, messageIds: string[]): ContextMessage[] {
    const store = this.store(chatIdOf(chatKey));
    const found = this.keys(chatKey).flatMap((key) => store.find(key, messageIds));
    return [...new Map(found.map((message) => [message.messageId, message])).values()];
  }

  prune(): void {
    for (const store of this.stores.values()) store.prune();
  }

  async flush(): Promise<void> {
    await Promise.all([...this.stores.values()].map((store) => store.flush()));
  }
}

export class ScopedGroupContext {
  private readonly stores = new Map<string, GroupContextStore>();

  constructor(
    private readonly layout: GroupStateLayout,
    logger?: Logger,
  ) {
    this.logger = logger;
  }

  private readonly logger?: Logger;

  async load(): Promise<void> {
    for (const info of this.layout.all()) await this.store(info.chatId).load();
  }

  private store(chatId: string): GroupContextStore {
    const existing = this.stores.get(chatId);
    if (existing) return existing;
    const store = new GroupContextStore(
      join(this.layout.dirFor(chatId), "group-context.json"),
      this.logger,
    );
    this.stores.set(chatId, store);
    return store;
  }

  get(chatId: string): GroupSummary | undefined {
    const key = chatId.includes(":") ? chatId : `feishu:${chatId}`;
    const store = this.store(chatIdOf(key));
    const normalized = this.layout.conversationIdFor(chatIdOf(key));
    return (
      (normalized ? store.get(normalized) : undefined) ??
      store.get(key)
    );
  }

  set(chatId: string, summary: GroupSummary): void {
    const key = chatId.includes(":") ? chatId : `feishu:${chatId}`;
    const target = this.layout.conversationIdFor(chatIdOf(key)) ?? key;
    this.store(chatIdOf(target)).set(target, summary);
  }

  size(): number {
    return [...this.stores.values()].reduce((sum, store) => sum + store.size(), 0);
  }

  list(): GroupSummary[] {
    return [...this.stores.values()].flatMap((store) => store.list());
  }

  async flush(): Promise<void> {
    await Promise.all([...this.stores.values()].map((store) => store.flush()));
  }
}

export class ScopedMemory {
  private readonly stores = new Map<string, MemoryStore>();

  constructor(
    private readonly layout: GroupStateLayout,
    private readonly options: {
      maxEntries: number;
      ttlMs: number;
      pinnedKinds: MemoryKind[];
      logger?: Logger;
    },
  ) {}

  async load(): Promise<void> {
    for (const info of this.layout.all()) await this.store(info.chatId).load();
  }

  async migrateShards(): Promise<void> {
    // Per-group stores already use their own shard directory.
  }

  private store(chatId: string | undefined): MemoryStore {
    const key = chatId ?? "_global";
    const existing = this.stores.get(key);
    if (existing) return existing;
    const dir = chatId ? this.layout.dirFor(chatId) : join(this.layout.rootPath(), "_unassigned");
    const store = new MemoryStore({
      file: join(dir, "memory.json"),
      shardDir: join(dir, "memory"),
      maxEntries: this.options.maxEntries,
      ttlMs: this.options.ttlMs,
      pinnedKinds: this.options.pinnedKinds,
      ...(this.options.logger ? { logger: this.options.logger } : {}),
    });
    this.stores.set(key, store);
    return store;
  }

  upsert(input: MemoryInput): MemoryRecord {
    return this.store(input.chatId).upsert(input);
  }

  query(input: MemoryQuery): MemoryRecord[] {
    if (input.chatId) return this.store(input.chatId).query(input);
    return [...this.stores.values()].flatMap((store) => store.query(input));
  }

  get(id: string): MemoryRecord | undefined {
    for (const store of this.stores.values()) {
      const found = store.get(id);
      if (found) return found;
    }
    return undefined;
  }

  delete(id: string): boolean {
    for (const store of this.stores.values()) {
      if (store.delete(id)) return true;
    }
    return false;
  }

  async flush(): Promise<void> {
    await Promise.all([...this.stores.values()].map((store) => store.flush()));
  }
}

export class ScopedEvidence {
  private readonly stores = new Map<string, EvidenceStore>();

  constructor(
    private readonly layout: GroupStateLayout,
    private readonly options: Omit<ConstructorParameters<typeof EvidenceStore>[0], "dir">,
  ) {}

  private store(chatId: string): EvidenceStore {
    const existing = this.stores.get(chatId);
    if (existing) return existing;
    const store = new EvidenceStore({
      ...this.options,
      dir: join(this.layout.dirFor(chatId), "replies"),
    });
    this.stores.set(chatId, store);
    return store;
  }

  append(record: EvidenceRecord): void {
    this.store(record.chatId).append(record);
  }

  search(input: { chatId: string; terms: string[]; days?: number; limit?: number }): EvidenceRecord[] {
    return this.store(chatIdOf(input.chatId)).search(input);
  }

  findByMessageId(input: { chatId: string; messageId: string; days?: number }): EvidenceRecord | undefined {
    return this.store(chatIdOf(input.chatId)).findByMessageId(input);
  }

  findReplyChain(input: {
    chatId: string;
    messageId: string;
    maxDepth?: number;
    days?: number;
  }): EvidenceRecord[] {
    return this.store(chatIdOf(input.chatId)).findReplyChain(input);
  }

  findMessageChain(input: {
    chatId: string;
    messageId: string;
    maxDepth?: number;
    maxThread?: number;
    days?: number;
  }) {
    return this.store(chatIdOf(input.chatId)).findMessageChain(input);
  }

  redact(chatId: string, messageId: string): void {
    this.store(chatIdOf(chatId)).redact(chatIdOf(chatId), messageId);
  }

  prune(): void {
    for (const info of this.layout.all()) this.store(info.chatId).prune();
  }
}

export class ScopedTasks {
  private readonly stores = new Map<string, TaskStore>();

  constructor(
    private readonly layout: GroupStateLayout,
    private readonly logger?: Logger,
    private readonly dbFor?: (chatId: string) => import("./task-state-db.js").TaskStateDb,
  ) {}

  async load(): Promise<void> {
    for (const info of this.layout.all()) await this.store(info.chatId).load();
  }

  private store(chatId: string): TaskStore {
    const existing = this.stores.get(chatId);
    if (existing) return existing;
    const dir = this.layout.dirFor(chatId);
    const state = this.dbFor?.(chatId);
    const store = new TaskStore(dir, this.logger, state ? undefined : join(dir, "cache", "state.db"), state);
    this.stores.set(chatId, store);
    return store;
  }

  async get(taskId: string) {
    for (const store of this.stores.values()) {
      const found = await store.get(taskId);
      if (found) return found;
    }
    return undefined;
  }

  findByDedupKey(dedupKey: string): string | undefined {
    for (const store of this.stores.values()) {
      const found = store.findByDedupKey(dedupKey);
      if (found) return found;
    }
    return undefined;
  }

  async findByMessageId(messageId: string) {
    for (const store of this.stores.values()) {
      const found = await store.findByMessageId(messageId);
      if (found) return found;
    }
    return undefined;
  }

  async list() {
    const all = await Promise.all([...this.stores.values()].map((store) => store.list()));
    return all.flat();
  }

  async save(task: Parameters<TaskStore["save"]>[0]): Promise<void> {
    await this.store(task.chatId).save(task);
  }

  async redactMessage(chatId: string, messageId: string): Promise<void> {
    await this.store(chatId).redactMessage(messageId);
  }

  forgetTask(chatId: string, taskId: string): void {
    this.store(chatId).forgetTask(taskId);
  }

  async flush(): Promise<void> {
    await Promise.all([...this.stores.values()].map((store) => store.flush()));
  }

  async close(): Promise<void> {
    await Promise.all([...this.stores.values()].map((store) => store.close()));
  }
}

export class ScopedPending {
  private readonly stores = new Map<string, PendingStore>();

  constructor(
    private readonly layout: GroupStateLayout,
    private readonly logger?: Logger,
  ) {}

  async load(): Promise<void> {
    for (const info of this.layout.all()) await this.store(info.chatId).load();
  }

  private store(chatId: string): PendingStore {
    const existing = this.stores.get(chatId);
    if (existing) return existing;
    const store = new PendingStore(
      join(chatId ? this.layout.dirFor(chatId) : this.layout.unassignedPath(), "pending.json"),
      this.logger,
    );
    this.stores.set(chatId, store);
    return store;
  }

  get(key: string): PendingCard | undefined {
    for (const store of this.stores.values()) {
      const found = store.get(key);
      if (found) return found;
    }
    return undefined;
  }

  findForTask(taskId: string): PendingCard | undefined {
    for (const store of this.stores.values()) {
      const found = store.findForTask(taskId);
      if (found) return found;
    }
    return undefined;
  }

  set(key: string, card: PendingCard): void {
    const chatId = card.chatId ?? "";
    this.store(chatId).set(key, card);
  }

  delete(key: string): void {
    for (const store of this.stores.values()) store.delete(key);
  }

  deleteForTask(taskId: string): void {
    for (const store of this.stores.values()) store.deleteForTask(taskId);
  }

  snapshot(): Array<[string, PendingCard]> {
    return [...this.stores.values()].flatMap((store) => store.snapshot());
  }

  async flush(): Promise<void> {
    await Promise.all([...this.stores.values()].map((store) => store.flush()));
  }
}

export class ScopedSessions {
  private readonly stores = new Map<string, SessionStore>();

  constructor(
    private readonly layout: GroupStateLayout,
    private readonly logger?: Logger,
  ) {}

  async load(): Promise<void> {
    for (const info of this.layout.all()) await this.store(info.chatId).load();
  }

  private store(chatId: string): SessionStore {
    const existing = this.stores.get(chatId);
    if (existing) return existing;
    const store = new SessionStore(
      join(chatId ? this.layout.dirFor(chatId) : this.layout.unassignedPath(), "sessions.json"),
      this.logger,
    );
    this.stores.set(chatId, store);
    return store;
  }

  get(key: string): SessionRecord | undefined {
    for (const store of this.stores.values()) {
      const found = store.get(key);
      if (found) return found;
    }
    return undefined;
  }

  set(
    key: string,
    sessionId: string,
    directory: string,
    meta?: { kind?: SessionKind; taskId?: string; conversationId?: string; contextKey?: string; createdAt?: number; archivedAt?: number; chatId?: string },
  ): void {
    const existingChatId = this.get(key)?.chatId;
    const chatId =
      meta?.chatId ?? existingChatId ?? (key.includes("feishu:") ? chatIdOf(key) : "");
    this.store(chatId).set(key, sessionId, directory, { ...meta, ...(chatId ? { chatId } : {}) });
  }

  list(kind?: SessionKind): Array<[string, SessionRecord]> {
    return [...this.stores.values()].flatMap((store) => store.list(kind));
  }

  delete(key: string): void {
    for (const store of this.stores.values()) store.delete(key);
  }

  findByTask(taskId: string, kind: SessionKind = "child"): Array<[string, SessionRecord]> {
    return [...this.stores.values()].flatMap((store) => store.findByTask(taskId, kind));
  }

  markContextDirty(sessionId: string): boolean {
    for (const store of this.stores.values()) {
      if (store.markContextDirty(sessionId)) return true;
    }
    return false;
  }

  async flush(): Promise<void> {
    await Promise.all([...this.stores.values()].map((store) => store.flush()));
  }
}

export class ScopedSentReplies {
  private readonly stores = new Map<string, SentReplyStore>();

  constructor(
    private readonly layout: GroupStateLayout,
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly logger?: Logger,
  ) {}

  async load(): Promise<void> {
    for (const info of this.layout.all()) await this.store(info.chatId).load();
  }

  private store(chatId: string): SentReplyStore {
    if (chatId.startsWith("user:")) {
      const dm = this.layout.all().find((info) => info.name === "私聊");
      if (dm) chatId = dm.chatId;
    }
    const existing = this.stores.get(chatId);
    if (existing) return existing;
    const store = new SentReplyStore(
      join(chatId ? this.layout.dirFor(chatId) : this.layout.unassignedPath(), "sent-replies.json"),
      this.ttlMs,
      this.maxEntries,
      this.logger,
    );
    this.stores.set(chatId, store);
    return store;
  }

  add(input: Omit<SentReplyRecord, "id" | "status">): Promise<SentReplyRecord> {
    return this.store(input.chatId).add(input);
  }

  list(limit = 5): SentReplyRecord[] {
    return [...this.stores.values()].flatMap((store) => store.list(limit)).slice(0, limit);
  }

  listRecallable(limit = 5, now = Date.now()): SentReplyRecord[] {
    return [...this.stores.values()]
      .flatMap((store) => store.listRecallable(limit, now))
      .slice(0, limit);
  }

  get(id: string): SentReplyRecord | undefined {
    for (const store of this.stores.values()) {
      const found = store.get(id);
      if (found) return found;
    }
    return undefined;
  }

  hasSource(sourceMessageId: string): boolean {
    return [...this.stores.values()].some((store) => store.hasSource(sourceMessageId));
  }

  listBySource(sourceMessageId: string): SentReplyRecord[] {
    return [...this.stores.values()].flatMap((store) => store.listBySource(sourceMessageId));
  }

  async markRecalled(id: string, at = Date.now()): Promise<boolean> {
    for (const store of this.stores.values()) {
      if (await store.markRecalled(id, at)) return true;
    }
    return false;
  }

  async flush(): Promise<void> {
    await Promise.all([...this.stores.values()].map((store) => store.flush()));
  }
}

export class ScopedCursors {
  private readonly stores = new Map<string, CursorStore>();

  constructor(
    private readonly layout: GroupStateLayout,
    private readonly logger?: Logger,
  ) {}

  async load(): Promise<void> {
    for (const info of this.layout.all()) await this.store(info.chatId).load();
  }

  private store(chatId: string): CursorStore {
    const existing = this.stores.get(chatId);
    if (existing) return existing;
    const store = new CursorStore({
      file: join(this.layout.dirFor(chatId), "cursors.json"),
      ...(this.logger ? { logger: this.logger } : {}),
    });
    this.stores.set(chatId, store);
    return store;
  }

  get(chatId: string): number | undefined {
    return this.store(chatIdOf(chatId)).get(chatId);
  }

  record(chatId: string): CursorRecord | undefined {
    return this.store(chatIdOf(chatId)).record(chatId);
  }

  set(chatId: string, lastEndTime: number, last?: { messageId?: string; messageTime?: number }): void {
    this.store(chatIdOf(chatId)).set(chatId, lastEndTime, last);
  }

  async flush(): Promise<void> {
    await Promise.all([...this.stores.values()].map((store) => store.flush()));
  }
}

export class ScopedProjects {
  private readonly stores = new Map<string, ProjectStore>();

  constructor(
    private readonly layout: GroupStateLayout,
    private readonly logger?: Logger,
  ) {}

  async load(): Promise<void> {
    for (const info of this.layout.all()) await this.store(info.chatId).load();
  }

  private store(chatId: string): ProjectStore {
    const existing = this.stores.get(chatId);
    if (existing) return existing;
    const store = new ProjectStore(join(this.layout.dirFor(chatId), "projects.json"), this.logger);
    this.stores.set(chatId, store);
    return store;
  }

  get(chatId: string): BoundProject | undefined {
    return this.store(chatIdOf(chatId)).get(chatId);
  }

  set(chatId: string, project: BoundProject): void {
    this.store(chatIdOf(chatId)).set(chatId, project);
  }

  delete(chatId: string): void {
    this.store(chatIdOf(chatId)).delete(chatId);
  }

  async flush(): Promise<void> {
    await Promise.all([...this.stores.values()].map((store) => store.flush()));
  }
}

export class ScopedApprovals {
  private readonly stores = new Map<string, ApprovalStore>();

  constructor(
    private readonly layout: GroupStateLayout,
    private readonly chatForTask: (taskId: string) => Promise<string | undefined>,
  ) {}

  private async storeForTask(taskId: string): Promise<ApprovalStore> {
    const chatId = (await this.chatForTask(taskId)) ?? "";
    const key = chatId || "_unassigned";
    const existing = this.stores.get(key);
    if (existing) return existing;
    const store = new ApprovalStore(chatId ? this.layout.dirFor(chatId) : join(this.layout.rootPath(), "_unassigned"));
    this.stores.set(key, store);
    return store;
  }

  async list(taskId: string) {
    return (await this.storeForTask(taskId)).list(taskId);
  }

  async latest(taskId: string, kind: Parameters<ApprovalStore["latest"]>[1]) {
    return (await this.storeForTask(taskId)).latest(taskId, kind);
  }

  async append(record: Parameters<ApprovalStore["append"]>[0]) {
    return (await this.storeForTask(record.taskId)).append(record);
  }

  async replaceLatest(record: Parameters<ApprovalStore["replaceLatest"]>[0]) {
    return (await this.storeForTask(record.taskId)).replaceLatest(record);
  }
}

export class ScopedDedup {
  private readonly stores = new Map<string, DedupStore>();

  constructor(
    private readonly layout: GroupStateLayout,
    private readonly filename: string,
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly logger?: Logger,
  ) {}

  async load(): Promise<void> {
    for (const info of this.layout.all()) await this.store(info.chatId).load();
    await this.store("").load();
  }

  private store(chatId: string): DedupStore {
    const key = chatId || "_unassigned";
    const existing = this.stores.get(key);
    if (existing) return existing;
    const dir = chatId ? this.layout.dirFor(chatId) : this.layout.unassignedPath();
    const store = new DedupStore({
      file: join(dir, this.filename),
      ttlMs: this.ttlMs,
      maxEntries: this.maxEntries,
      ...(this.logger ? { logger: this.logger } : {}),
    });
    this.stores.set(key, store);
    return store;
  }

  has(key: string, chatId?: string): boolean {
    if (chatId) return this.store(chatId).has(key);
    for (const store of this.stores.values()) if (store.has(key)) return true;
    return false;
  }

  add(key: string, chatId?: string): void {
    this.store(chatId ?? "").add(key);
  }

  delete(key: string, chatId?: string): void {
    if (chatId) {
      this.store(chatId).delete(key);
      return;
    }
    for (const store of this.stores.values()) store.delete(key);
  }

  async flush(): Promise<void> {
    await Promise.all([...this.stores.values()].map((store) => store.flush()));
  }

  async close(): Promise<void> {
    await Promise.all([...this.stores.values()].map((store) => store.close()));
  }
}

export class ScopedAudit {
  private readonly stores = new Map<string, AuditLog>();

  constructor(
    private readonly layout: GroupStateLayout,
    private readonly chatForTask: (taskId: string) => Promise<string | undefined>,
  ) {}

  private async storeFor(input: {
    taskId?: string;
    details?: Record<string, unknown>;
  }): Promise<AuditLog> {
    let chatId = input.taskId ? await this.chatForTask(input.taskId) : undefined;
    if (!chatId && typeof input.details?.chatId === "string") {
      chatId = input.details.chatId;
    }
    const key = chatId || "_unassigned";
    const existing = this.stores.get(key);
    if (existing) return existing;
    const dir = chatId ? this.layout.dirFor(chatId) : this.layout.unassignedPath();
    const store = new AuditLog(join(dir, "audit.jsonl"));
    this.stores.set(key, store);
    return store;
  }

  async append(input: {
    actor: Parameters<AuditLog["append"]>[0]["actor"];
    action: string;
    taskId?: string;
    details?: Record<string, unknown>;
  }) {
    return (await this.storeFor(input)).append(input);
  }
}
