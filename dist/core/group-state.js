import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "./logger.js";
import { ChatContextStore } from "./chat-context.js";
import { GroupContextStore } from "./group-context.js";
import { MemoryStore } from "./memory-store.js";
import { EvidenceStore } from "./evidence-store.js";
import { TaskStore } from "./task-store.js";
import { PendingStore } from "./pending-store.js";
import { SessionStore } from "./session-store.js";
import { SentReplyStore } from "./sent-reply-store.js";
import { CursorStore } from "./cursor.js";
import { ProjectStore } from "./project-store.js";
import { ApprovalStore } from "./approval-store.js";
import { DedupStore } from "./dedup.js";
import { AuditLog } from "./audit.js";
import { readJsonFile } from "./util.js";
const UNSAFE = /[/\\:*?"<>|]/g;
export function groupDirName(chatId, name) {
    const display = name || (chatId.startsWith("oc_b0143a44") ? "私聊" : `群_${shortId(chatId)}`);
    return `${sanitize(display)}__${shortId(chatId)}`;
}
function sanitize(value) {
    return (value.replace(UNSAFE, "_").trim() || "群").slice(0, 40);
}
export function shortGroupId(chatId) {
    const id = chatId.split(":").pop() ?? chatId;
    return id.slice(0, 11);
}
function shortId(chatId) {
    const id = chatId.split(":").pop() ?? chatId;
    return id.slice(0, 11);
}
function chatIdOf(key) {
    return key.split(":").pop() ?? key;
}
export class GroupStateLayout {
    root;
    byChat = new Map();
    byDir = new Map();
    logger;
    constructor(root, logger) {
        this.root = root;
        this.logger = logger ?? createLogger({ scope: "group-state" });
    }
    async load() {
        await mkdir(this.root, { recursive: true });
        let entries = [];
        try {
            entries = await readdir(this.root);
        }
        catch {
            return;
        }
        for (const dirName of entries) {
            if (dirName.startsWith("_"))
                continue;
            const dir = join(this.root, dirName);
            try {
                const data = await readJsonFile(join(dir, "group.json"), {});
                if (!data.chatId)
                    continue;
                const info = {
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
            }
            catch {
                continue;
            }
        }
        this.logger.info("group state layout loaded", { groups: this.byChat.size });
    }
    async ensure(chatId, name, options) {
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
            if (changed)
                await this.writeGroupJson(existing);
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
        }
        else if (info.chatId !== chatId) {
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
    async writeGroupJson(info) {
        await mkdir(info.dir, { recursive: true });
        const path = join(info.dir, "group.json");
        const previous = await readFile(path, "utf8")
            .then((raw) => JSON.parse(raw))
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
    dirFor(chatId) {
        return this.byChat.get(chatId)?.dir ?? join(this.root, `群_${shortId(chatId)}`);
    }
    conversationIdFor(chatId) {
        return this.byChat.get(chatId)?.conversationId;
    }
    rootPath() {
        return this.root;
    }
    unassignedPath() {
        return join(this.root, "_unassigned");
    }
    all() {
        return [...this.byChat.values()];
    }
}
export class ScopedChatContext {
    layout;
    options;
    stores = new Map();
    constructor(layout, options) {
        this.layout = layout;
        this.options = options;
    }
    async load() {
        for (const info of this.layout.all())
            await this.store(info.chatId).load();
    }
    store(chatId) {
        const existing = this.stores.get(chatId);
        if (existing)
            return existing;
        const store = new ChatContextStore({
            ...this.options,
            file: join(this.layout.dirFor(chatId), "chat-context.json"),
        });
        this.stores.set(chatId, store);
        return store;
    }
    normalizedKey(chatKey) {
        return this.layout.conversationIdFor(chatIdOf(chatKey)) ?? chatKey;
    }
    keys(chatKey) {
        const normalized = this.normalizedKey(chatKey);
        return normalized === chatKey ? [chatKey] : [normalized, chatKey];
    }
    get(chatKey) {
        const store = this.store(chatIdOf(chatKey));
        for (const key of this.keys(chatKey)) {
            const context = store.get(key);
            if (context)
                return context;
        }
        return undefined;
    }
    append(chatKey, message, meta) {
        const key = this.normalizedKey(chatKey);
        this.store(chatIdOf(key)).append(key, message, meta);
    }
    redact(chatKey, messageId) {
        return this.store(chatIdOf(chatKey)).redact(chatKey, messageId);
    }
    bindProject(chatKey, projectId, worktree) {
        const key = this.normalizedKey(chatKey);
        this.store(chatIdOf(key)).bindProject(key, projectId, worktree);
    }
    recent(chatKey, limit, excludeMessageId) {
        const store = this.store(chatIdOf(chatKey));
        const messages = this.keys(chatKey).flatMap((key) => store.recent(key, limit, excludeMessageId));
        if (this.keys(chatKey).length === 1)
            return messages.slice(-limit);
        const byId = new Map();
        for (const message of messages)
            byId.set(message.messageId, message);
        return [...byId.values()]
            .sort((a, b) => a.at - b.at)
            .slice(-limit);
    }
    find(chatKey, messageIds) {
        const store = this.store(chatIdOf(chatKey));
        const found = this.keys(chatKey).flatMap((key) => store.find(key, messageIds));
        return [...new Map(found.map((message) => [message.messageId, message])).values()];
    }
    prune() {
        for (const store of this.stores.values())
            store.prune();
    }
    async flush() {
        await Promise.all([...this.stores.values()].map((store) => store.flush()));
    }
}
export class ScopedGroupContext {
    layout;
    stores = new Map();
    constructor(layout, logger) {
        this.layout = layout;
        this.logger = logger;
    }
    logger;
    async load() {
        for (const info of this.layout.all())
            await this.store(info.chatId).load();
    }
    store(chatId) {
        const existing = this.stores.get(chatId);
        if (existing)
            return existing;
        const store = new GroupContextStore(join(this.layout.dirFor(chatId), "group-context.json"), this.logger);
        this.stores.set(chatId, store);
        return store;
    }
    get(chatId) {
        const key = chatId.includes(":") ? chatId : `feishu:${chatId}`;
        const store = this.store(chatIdOf(key));
        const normalized = this.layout.conversationIdFor(chatIdOf(key));
        return ((normalized ? store.get(normalized) : undefined) ??
            store.get(key));
    }
    set(chatId, summary) {
        const key = chatId.includes(":") ? chatId : `feishu:${chatId}`;
        const target = this.layout.conversationIdFor(chatIdOf(key)) ?? key;
        this.store(chatIdOf(target)).set(target, summary);
    }
    size() {
        return [...this.stores.values()].reduce((sum, store) => sum + store.size(), 0);
    }
    list() {
        return [...this.stores.values()].flatMap((store) => store.list());
    }
    async flush() {
        await Promise.all([...this.stores.values()].map((store) => store.flush()));
    }
}
export class ScopedMemory {
    layout;
    options;
    stores = new Map();
    constructor(layout, options) {
        this.layout = layout;
        this.options = options;
    }
    async load() {
        for (const info of this.layout.all())
            await this.store(info.chatId).load();
    }
    async migrateShards() {
        // Per-group stores already use their own shard directory.
    }
    store(chatId) {
        const key = chatId ?? "_global";
        const existing = this.stores.get(key);
        if (existing)
            return existing;
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
    upsert(input) {
        return this.store(input.chatId).upsert(input);
    }
    query(input) {
        if (input.chatId)
            return this.store(input.chatId).query(input);
        return [...this.stores.values()].flatMap((store) => store.query(input));
    }
    get(id) {
        for (const store of this.stores.values()) {
            const found = store.get(id);
            if (found)
                return found;
        }
        return undefined;
    }
    delete(id) {
        for (const store of this.stores.values()) {
            if (store.delete(id))
                return true;
        }
        return false;
    }
    async flush() {
        await Promise.all([...this.stores.values()].map((store) => store.flush()));
    }
}
export class ScopedEvidence {
    layout;
    options;
    stores = new Map();
    constructor(layout, options) {
        this.layout = layout;
        this.options = options;
    }
    store(chatId) {
        const existing = this.stores.get(chatId);
        if (existing)
            return existing;
        const store = new EvidenceStore({
            ...this.options,
            dir: join(this.layout.dirFor(chatId), "replies"),
        });
        this.stores.set(chatId, store);
        return store;
    }
    async append(record) {
        await this.store(record.chatId).append(record);
    }
    async search(input) {
        return this.store(chatIdOf(input.chatId)).search(input);
    }
    async findByMessageId(input) {
        return this.store(chatIdOf(input.chatId)).findByMessageId(input);
    }
    async findReplyChain(input) {
        return this.store(chatIdOf(input.chatId)).findReplyChain(input);
    }
    async findMessageChain(input) {
        return this.store(chatIdOf(input.chatId)).findMessageChain(input);
    }
    async redact(chatId, messageId) {
        await this.store(chatIdOf(chatId)).redact(chatIdOf(chatId), messageId);
    }
    async prune() {
        await Promise.all(this.layout.all().map((info) => this.store(info.chatId).prune()));
    }
    async flush() {
        await Promise.all([...this.stores.values()].map((store) => store.flush()));
    }
}
export class ScopedTasks {
    layout;
    logger;
    dbFor;
    stores = new Map();
    constructor(layout, logger, dbFor) {
        this.layout = layout;
        this.logger = logger;
        this.dbFor = dbFor;
    }
    async load() {
        for (const info of this.layout.all())
            await this.store(info.chatId).load();
    }
    store(chatId) {
        const existing = this.stores.get(chatId);
        if (existing)
            return existing;
        const dir = this.layout.dirFor(chatId);
        const state = this.dbFor?.(chatId);
        const store = new TaskStore(dir, this.logger, state ? undefined : join(dir, "cache", "state.db"), state);
        this.stores.set(chatId, store);
        return store;
    }
    async get(taskId) {
        for (const store of this.stores.values()) {
            const found = await store.get(taskId);
            if (found)
                return found;
        }
        return undefined;
    }
    findByDedupKey(dedupKey) {
        for (const store of this.stores.values()) {
            const found = store.findByDedupKey(dedupKey);
            if (found)
                return found;
        }
        return undefined;
    }
    async findByMessageId(messageId) {
        for (const store of this.stores.values()) {
            const found = await store.findByMessageId(messageId);
            if (found)
                return found;
        }
        return undefined;
    }
    async list() {
        const all = await Promise.all([...this.stores.values()].map((store) => store.list()));
        return all.flat();
    }
    async save(task) {
        await this.store(task.chatId).save(task);
    }
    async redactMessage(chatId, messageId) {
        await this.store(chatId).redactMessage(messageId);
    }
    forgetTask(chatId, taskId) {
        this.store(chatId).forgetTask(taskId);
    }
    async flush() {
        await Promise.all([...this.stores.values()].map((store) => store.flush()));
    }
    async close() {
        await Promise.all([...this.stores.values()].map((store) => store.close()));
    }
}
export class ScopedPending {
    layout;
    logger;
    stores = new Map();
    constructor(layout, logger) {
        this.layout = layout;
        this.logger = logger;
    }
    async load() {
        for (const info of this.layout.all())
            await this.store(info.chatId).load();
    }
    store(chatId) {
        const existing = this.stores.get(chatId);
        if (existing)
            return existing;
        const store = new PendingStore(join(chatId ? this.layout.dirFor(chatId) : this.layout.unassignedPath(), "pending.json"), this.logger);
        this.stores.set(chatId, store);
        return store;
    }
    get(key) {
        for (const store of this.stores.values()) {
            const found = store.get(key);
            if (found)
                return found;
        }
        return undefined;
    }
    findForTask(taskId) {
        for (const store of this.stores.values()) {
            const found = store.findForTask(taskId);
            if (found)
                return found;
        }
        return undefined;
    }
    set(key, card) {
        const chatId = card.chatId ?? "";
        this.store(chatId).set(key, card);
    }
    delete(key) {
        for (const store of this.stores.values())
            store.delete(key);
    }
    deleteForTask(taskId) {
        for (const store of this.stores.values())
            store.deleteForTask(taskId);
    }
    snapshot() {
        return [...this.stores.values()].flatMap((store) => store.snapshot());
    }
    async flush() {
        await Promise.all([...this.stores.values()].map((store) => store.flush()));
    }
}
export class ScopedSessions {
    layout;
    logger;
    stores = new Map();
    constructor(layout, logger) {
        this.layout = layout;
        this.logger = logger;
    }
    async load() {
        for (const info of this.layout.all())
            await this.store(info.chatId).load();
    }
    store(chatId) {
        const existing = this.stores.get(chatId);
        if (existing)
            return existing;
        const store = new SessionStore(join(chatId ? this.layout.dirFor(chatId) : this.layout.unassignedPath(), "sessions.json"), this.logger);
        this.stores.set(chatId, store);
        return store;
    }
    get(key) {
        for (const store of this.stores.values()) {
            const found = store.get(key);
            if (found)
                return found;
        }
        return undefined;
    }
    set(key, sessionId, directory, meta) {
        const existingChatId = this.get(key)?.chatId;
        const chatId = meta?.chatId ?? existingChatId ?? (key.includes("feishu:") ? chatIdOf(key) : "");
        this.store(chatId).set(key, sessionId, directory, { ...meta, ...(chatId ? { chatId } : {}) });
    }
    list(kind) {
        return [...this.stores.values()].flatMap((store) => store.list(kind));
    }
    delete(key) {
        for (const store of this.stores.values())
            store.delete(key);
    }
    findByTask(taskId, kind = "child") {
        return [...this.stores.values()].flatMap((store) => store.findByTask(taskId, kind));
    }
    markContextDirty(sessionId) {
        for (const store of this.stores.values()) {
            if (store.markContextDirty(sessionId))
                return true;
        }
        return false;
    }
    async flush() {
        await Promise.all([...this.stores.values()].map((store) => store.flush()));
    }
}
export class ScopedSentReplies {
    layout;
    ttlMs;
    maxEntries;
    logger;
    stores = new Map();
    constructor(layout, ttlMs, maxEntries, logger) {
        this.layout = layout;
        this.ttlMs = ttlMs;
        this.maxEntries = maxEntries;
        this.logger = logger;
    }
    async load() {
        for (const info of this.layout.all())
            await this.store(info.chatId).load();
    }
    store(chatId) {
        if (chatId.startsWith("user:")) {
            const dm = this.layout.all().find((info) => info.name === "私聊");
            if (dm)
                chatId = dm.chatId;
        }
        const existing = this.stores.get(chatId);
        if (existing)
            return existing;
        const store = new SentReplyStore(join(chatId ? this.layout.dirFor(chatId) : this.layout.unassignedPath(), "sent-replies.json"), this.ttlMs, this.maxEntries, this.logger);
        this.stores.set(chatId, store);
        return store;
    }
    add(input) {
        return this.store(input.chatId).add(input);
    }
    list(limit = 5) {
        return [...this.stores.values()].flatMap((store) => store.list(limit)).slice(0, limit);
    }
    listRecallable(limit = 5, now = Date.now()) {
        return [...this.stores.values()]
            .flatMap((store) => store.listRecallable(limit, now))
            .slice(0, limit);
    }
    get(id) {
        for (const store of this.stores.values()) {
            const found = store.get(id);
            if (found)
                return found;
        }
        return undefined;
    }
    hasSource(sourceMessageId) {
        return [...this.stores.values()].some((store) => store.hasSource(sourceMessageId));
    }
    listBySource(sourceMessageId) {
        return [...this.stores.values()].flatMap((store) => store.listBySource(sourceMessageId));
    }
    async markRecalled(id, at = Date.now()) {
        for (const store of this.stores.values()) {
            if (await store.markRecalled(id, at))
                return true;
        }
        return false;
    }
    async flush() {
        await Promise.all([...this.stores.values()].map((store) => store.flush()));
    }
}
export class ScopedCursors {
    layout;
    logger;
    stores = new Map();
    constructor(layout, logger) {
        this.layout = layout;
        this.logger = logger;
    }
    async load() {
        for (const info of this.layout.all())
            await this.store(info.chatId).load();
    }
    store(chatId) {
        const existing = this.stores.get(chatId);
        if (existing)
            return existing;
        const store = new CursorStore({
            file: join(this.layout.dirFor(chatId), "cursors.json"),
            ...(this.logger ? { logger: this.logger } : {}),
        });
        this.stores.set(chatId, store);
        return store;
    }
    get(chatId) {
        return this.store(chatIdOf(chatId)).get(chatId);
    }
    record(chatId) {
        return this.store(chatIdOf(chatId)).record(chatId);
    }
    set(chatId, lastEndTime, last) {
        this.store(chatIdOf(chatId)).set(chatId, lastEndTime, last);
    }
    async flush() {
        await Promise.all([...this.stores.values()].map((store) => store.flush()));
    }
}
export class ScopedProjects {
    layout;
    logger;
    stores = new Map();
    constructor(layout, logger) {
        this.layout = layout;
        this.logger = logger;
    }
    async load() {
        for (const info of this.layout.all())
            await this.store(info.chatId).load();
    }
    store(chatId) {
        const existing = this.stores.get(chatId);
        if (existing)
            return existing;
        const store = new ProjectStore(join(this.layout.dirFor(chatId), "projects.json"), this.logger);
        this.stores.set(chatId, store);
        return store;
    }
    get(chatId) {
        return this.store(chatIdOf(chatId)).get(chatId);
    }
    set(chatId, project) {
        this.store(chatIdOf(chatId)).set(chatId, project);
    }
    delete(chatId) {
        this.store(chatIdOf(chatId)).delete(chatId);
    }
    async flush() {
        await Promise.all([...this.stores.values()].map((store) => store.flush()));
    }
}
export class ScopedApprovals {
    layout;
    chatForTask;
    stores = new Map();
    constructor(layout, chatForTask) {
        this.layout = layout;
        this.chatForTask = chatForTask;
    }
    async storeForTask(taskId) {
        const chatId = (await this.chatForTask(taskId)) ?? "";
        const key = chatId || "_unassigned";
        const existing = this.stores.get(key);
        if (existing)
            return existing;
        const store = new ApprovalStore(chatId ? this.layout.dirFor(chatId) : join(this.layout.rootPath(), "_unassigned"));
        this.stores.set(key, store);
        return store;
    }
    async list(taskId) {
        return (await this.storeForTask(taskId)).list(taskId);
    }
    async latest(taskId, kind) {
        return (await this.storeForTask(taskId)).latest(taskId, kind);
    }
    async append(record) {
        return (await this.storeForTask(record.taskId)).append(record);
    }
    async replaceLatest(record) {
        return (await this.storeForTask(record.taskId)).replaceLatest(record);
    }
}
export class ScopedDedup {
    layout;
    filename;
    ttlMs;
    maxEntries;
    logger;
    stores = new Map();
    constructor(layout, filename, ttlMs, maxEntries, logger) {
        this.layout = layout;
        this.filename = filename;
        this.ttlMs = ttlMs;
        this.maxEntries = maxEntries;
        this.logger = logger;
    }
    async load() {
        for (const info of this.layout.all())
            await this.store(info.chatId).load();
        await this.store("").load();
    }
    store(chatId) {
        const key = chatId || "_unassigned";
        const existing = this.stores.get(key);
        if (existing)
            return existing;
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
    has(key, chatId) {
        if (chatId)
            return this.store(chatId).has(key);
        for (const store of this.stores.values())
            if (store.has(key))
                return true;
        return false;
    }
    add(key, chatId) {
        this.store(chatId ?? "").add(key);
    }
    delete(key, chatId) {
        if (chatId) {
            this.store(chatId).delete(key);
            return;
        }
        for (const store of this.stores.values())
            store.delete(key);
    }
    async flush() {
        await Promise.all([...this.stores.values()].map((store) => store.flush()));
    }
    async close() {
        await Promise.all([...this.stores.values()].map((store) => store.close()));
    }
}
export class ScopedAudit {
    layout;
    chatForTask;
    stores = new Map();
    constructor(layout, chatForTask) {
        this.layout = layout;
        this.chatForTask = chatForTask;
    }
    async storeFor(input) {
        let chatId = input.taskId ? await this.chatForTask(input.taskId) : undefined;
        if (!chatId && typeof input.details?.chatId === "string") {
            chatId = input.details.chatId;
        }
        const key = chatId || "_unassigned";
        const existing = this.stores.get(key);
        if (existing)
            return existing;
        const dir = chatId ? this.layout.dirFor(chatId) : this.layout.unassignedPath();
        const store = new AuditLog(join(dir, "audit.jsonl"));
        this.stores.set(key, store);
        return store;
    }
    async append(input) {
        return (await this.storeFor(input)).append(input);
    }
}
//# sourceMappingURL=group-state.js.map