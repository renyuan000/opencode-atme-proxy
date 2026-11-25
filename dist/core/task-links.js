import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "./logger.js";
import { readJsonFile, toErrorMessage, writeJsonAtomic } from "./util.js";
import { TaskStateDb } from "./task-state-db.js";
function emptyFile() {
    return { version: 1, byMessage: {}, bySession: {} };
}
export class TaskLinkStore {
    path;
    file = emptyFile();
    dirty = false;
    logger;
    constructor(path, logger) {
        this.path = path;
        this.logger = logger ?? createLogger({ scope: "task-links" });
    }
    async load() {
        try {
            const data = await readJsonFile(this.path, emptyFile());
            this.file = {
                version: 1,
                byMessage: data.byMessage ?? {},
                bySession: data.bySession ?? {},
            };
        }
        catch (error) {
            this.logger.warn("failed to load task links", { path: this.path, error: toErrorMessage(error) });
            this.file = emptyFile();
        }
    }
    async linkMessage(messageId, taskId) {
        if (!messageId || !taskId)
            return;
        if (this.file.byMessage[messageId] === taskId)
            return;
        this.file.byMessage[messageId] = taskId;
        this.dirty = true;
        await this.flush();
    }
    async linkSession(sessionId, taskId, role) {
        if (!sessionId || !taskId)
            return;
        this.file.bySession[sessionId] = { taskId, role };
        this.dirty = true;
        await this.flush();
    }
    findByMessage(messageId) {
        return this.file.byMessage[messageId];
    }
    findBySession(sessionId) {
        return this.file.bySession[sessionId];
    }
    findByTask(taskId) {
        return Object.entries(this.file.bySession)
            .filter(([, value]) => value.taskId === taskId)
            .map(([sessionId, value]) => ({ sessionId, role: value.role }));
    }
    snapshot() {
        return { version: 1, byMessage: { ...this.file.byMessage }, bySession: { ...this.file.bySession } };
    }
    async flush() {
        if (!this.dirty)
            return;
        await mkdir(join(this.path, ".."), { recursive: true });
        await writeJsonAtomic(this.path, this.file);
        this.dirty = false;
    }
}
export class ScopedTaskLinks {
    layout;
    stores = new Map();
    logger;
    constructor(layout, logger) {
        this.layout = layout;
        this.logger = logger ?? createLogger({ scope: "task-links" });
    }
    async load() {
        for (const info of this.layout.all())
            this.store(info.chatId);
    }
    database(chatId) {
        return this.store(chatId);
    }
    store(chatId) {
        const existing = this.stores.get(chatId);
        if (existing)
            return existing;
        const store = new TaskStateDb(join(this.layout.dirFor(chatId), "cache", "state.db"), chatId, this.logger.child(chatId));
        this.stores.set(chatId, store);
        return store;
    }
    async linkMessage(chatId, messageId, taskId) {
        this.store(chatId).linkMessage(messageId, taskId);
    }
    async linkSession(chatId, sessionId, taskId, role) {
        this.store(chatId).linkSession(sessionId, taskId, role);
    }
    findByMessage(chatId, messageId) {
        return this.store(chatId).findByMessage(messageId);
    }
    findByMessageAny(messageId) {
        for (const store of this.stores.values()) {
            const taskId = store.findByMessage(messageId);
            if (taskId)
                return taskId;
        }
        return undefined;
    }
    findBySession(chatId, sessionId) {
        return this.store(chatId).findBySession(sessionId);
    }
    findByTask(taskId) {
        return [...this.stores.entries()].flatMap(([chatId, store]) => store.findByTask(taskId).map((item) => ({ chatId, ...item })));
    }
    async flush() { }
    cleanup(linkDays, eventDays) {
        let links = 0;
        let events = 0;
        for (const store of this.stores.values()) {
            const result = store.cleanup({ linkDays, eventDays });
            links += result.links;
            events += result.events;
        }
        return { links, events };
    }
    close() {
        for (const store of this.stores.values())
            store.close();
        this.stores.clear();
    }
}
//# sourceMappingURL=task-links.js.map