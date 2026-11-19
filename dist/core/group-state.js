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
    async ensure(chatId, name) {
        const existing = this.byChat.get(chatId);
        if (existing)
            return existing;
        const displayName = name || (chatId.startsWith("oc_b0143a44") ? "私聊" : `群_${shortId(chatId)}`);
        let dirName = `${sanitize(displayName)}__${shortId(chatId)}`;
        let info = this.byDir.get(dirName);
        if (!info) {
            const dir = join(this.root, dirName);
            await mkdir(dir, { recursive: true });
            info = { chatId, name: displayName, dirName, dir };
            this.byChat.set(chatId, info);
            this.byDir.set(dirName, info);
            await this.writeGroupJson(info);
        }
        else if (info.chatId !== chatId) {
            dirName = `${sanitize(displayName)}__${shortId(chatId)}-${shortId(chatId).slice(-3)}`;
            const dir = join(this.root, dirName);
            await mkdir(dir, { recursive: true });
            info = { chatId, name: displayName, dirName, dir };
            this.byChat.set(chatId, info);
            this.byDir.set(dirName, info);
            await this.writeGroupJson(info);
        }
        return info;
    }
    async writeGroupJson(info) {
        await mkdir(info.dir, { recursive: true });
        const path = join(info.dir, "group.json");
        const existing = await readFile(path, "utf8").catch(() => "");
        if (existing)
            return;
        const body = {
            groupKey: `feishu:${info.chatId}`,
            chatId: info.chatId,
            name: info.name,
            shortId: shortId(info.chatId),
            dirName: info.dirName,
            createdAt: new Date().toISOString(),
            project: null,
        };
        const { writeJsonAtomic } = await import("./util.js");
        await writeJsonAtomic(path, body);
    }
    dirFor(chatId) {
        return this.byChat.get(chatId)?.dir ?? join(this.root, `群_${shortId(chatId)}`);
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
    get(chatKey) {
        return this.store(chatIdOf(chatKey)).get(chatKey);
    }
    append(chatKey, message, meta) {
        this.store(chatIdOf(chatKey)).append(chatKey, message, meta);
    }
    bindProject(chatKey, projectId, worktree) {
        this.store(chatIdOf(chatKey)).bindProject(chatKey, projectId, worktree);
    }
    recent(chatKey, limit, excludeMessageId) {
        return this.store(chatIdOf(chatKey)).recent(chatKey, limit, excludeMessageId);
    }
    find(chatKey, messageIds) {
        return this.store(chatIdOf(chatKey)).find(chatKey, messageIds);
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
        return this.store(chatIdOf(chatId)).get(chatId.includes(":") ? chatId : `feishu:${chatId}`);
    }
    set(chatId, summary) {
        const key = chatId.includes(":") ? chatId : `feishu:${chatId}`;
        this.store(chatIdOf(chatId)).set(key, summary);
    }
    size() {
        return [...this.stores.values()].reduce((sum, store) => sum + store.size(), 0);
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
    append(record) {
        this.store(record.chatId).append(record);
    }
    search(input) {
        return this.store(chatIdOf(input.chatId)).search(input);
    }
    findByMessageId(input) {
        return this.store(chatIdOf(input.chatId)).findByMessageId(input);
    }
    prune() {
        for (const info of this.layout.all())
            this.store(info.chatId).prune();
    }
}
export class ScopedTasks {
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
        const store = new TaskStore(this.layout.dirFor(chatId), this.logger);
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
        const chatId = meta?.chatId ?? (key.includes("feishu:") ? chatIdOf(key) : "");
        this.store(chatId).set(key, sessionId, directory, meta);
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