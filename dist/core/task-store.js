import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createLogger } from "./logger.js";
import { readJsonFile, writeJsonAtomic, toErrorMessage } from "./util.js";
export class TaskStore {
    dir;
    index = new Map();
    logger;
    indexDirty = false;
    db;
    state;
    constructor(dir, logger, dbPath, state) {
        this.dir = dir;
        this.logger = logger ?? createLogger({ scope: "tasks" });
        this.state = state;
        if (dbPath) {
            mkdirSync(dirname(dbPath), { recursive: true });
            this.db = new Database(dbPath);
            this.db.exec("PRAGMA journal_mode = WAL");
            this.db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          task_id TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS task_index (
          dedup_key TEXT PRIMARY KEY,
          task_id TEXT NOT NULL
        );
      `);
        }
    }
    taskPath(taskId) {
        return join(this.dir, "tasks", `${taskId}.json`);
    }
    indexPath() {
        return join(this.dir, "tasks", "index.json");
    }
    async load() {
        if (this.state) {
            if (this.state.taskCount() === 0)
                await this.migrateLegacyToState();
            for (const row of this.state.taskIndex())
                this.index.set(row.dedupKey, row.taskId);
            return;
        }
        if (this.db) {
            const rows = this.db.prepare("SELECT task_id, data FROM tasks").all();
            if (rows.length === 0)
                await this.migrateLegacyToDb();
            for (const row of this.db.prepare("SELECT dedup_key, task_id FROM task_index").all()) {
                this.index.set(row.dedup_key, row.task_id);
            }
            return;
        }
        try {
            const data = await readJsonFile(this.indexPath(), {
                version: 1,
                byDedupKey: {},
            });
            for (const [key, taskId] of Object.entries(data.byDedupKey ?? {})) {
                if (typeof taskId === "string")
                    this.index.set(key, taskId);
            }
        }
        catch (error) {
            this.logger.error("failed to load task index; starting empty", {
                error: toErrorMessage(error),
            });
        }
    }
    async get(taskId) {
        if (this.state) {
            const data = this.state.getTask(taskId);
            if (!data)
                return undefined;
            try {
                return JSON.parse(data);
            }
            catch {
                return undefined;
            }
        }
        if (this.db) {
            const row = this.db.prepare("SELECT data FROM tasks WHERE task_id = ?").get(taskId);
            if (!row?.data)
                return undefined;
            try {
                return JSON.parse(row.data);
            }
            catch {
                return undefined;
            }
        }
        try {
            return await readJsonFile(this.taskPath(taskId), undefined);
        }
        catch (error) {
            this.logger.error("failed to read task", { taskId, error: toErrorMessage(error) });
            return undefined;
        }
    }
    findByDedupKey(dedupKey) {
        return this.index.get(dedupKey);
    }
    async findByMessageId(messageId) {
        const tasks = await this.list();
        return tasks.find((task) => task.id === messageId || task.messageIds?.includes(messageId));
    }
    async list() {
        if (this.state) {
            return this.state.listTaskData()
                .map((data) => {
                try {
                    return JSON.parse(data);
                }
                catch {
                    return undefined;
                }
            })
                .filter((task) => Boolean(task));
        }
        if (this.db) {
            return this.db.prepare("SELECT data FROM tasks").all()
                .map((row) => {
                try {
                    return JSON.parse(row.data);
                }
                catch {
                    return undefined;
                }
            })
                .filter((task) => Boolean(task));
        }
        try {
            const files = await readdir(join(this.dir, "tasks"));
            const tasks = [];
            for (const file of files) {
                if (!file.endsWith(".json") || file === "index.json")
                    continue;
                const task = await readJsonFile(join(this.dir, "tasks", file), undefined);
                if (task && typeof task.id === "string")
                    tasks.push(task);
            }
            return tasks;
        }
        catch (error) {
            if (typeof error === "object" &&
                error !== null &&
                "code" in error &&
                error.code === "ENOENT") {
                return [];
            }
            this.logger.error("failed to list tasks", { error: toErrorMessage(error) });
            return [];
        }
    }
    forgetTask(taskId) {
        for (const [key, value] of this.index) {
            if (value === taskId)
                this.index.delete(key);
        }
    }
    async redactMessage(messageId) {
        const tasks = await this.list();
        for (const task of tasks) {
            if (!task.supplements?.some((item) => item.messageId === messageId))
                continue;
            task.supplements = task.supplements.map((item) => item.messageId === messageId ? { ...item, text: "[已撤回]" } : item);
            task.updatedAt = Date.now();
            await this.save(task);
        }
    }
    async saveWithLinks(task, messageIds) {
        if (!this.state)
            return false;
        this.state.saveTaskWithLinks(task.id, JSON.stringify(task), task.updatedAt, task.dedupKey, messageIds);
        this.index.set(task.dedupKey, task.id);
        return true;
    }
    async save(task) {
        if (this.state) {
            this.state.saveTask(task.id, JSON.stringify(task), task.updatedAt, task.dedupKey);
            this.index.set(task.dedupKey, task.id);
            return;
        }
        if (this.db) {
            const transaction = this.db.transaction(() => {
                this.db.prepare("INSERT INTO tasks(task_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at")
                    .run(task.id, JSON.stringify(task), task.updatedAt);
                this.db.prepare("INSERT INTO task_index(dedup_key, task_id) VALUES (?, ?) ON CONFLICT(dedup_key) DO UPDATE SET task_id = excluded.task_id")
                    .run(task.dedupKey, task.id);
            });
            transaction();
            this.index.set(task.dedupKey, task.id);
            return;
        }
        await writeJsonAtomic(this.taskPath(task.id), task);
        if (this.index.get(task.dedupKey) !== task.id) {
            this.index.set(task.dedupKey, task.id);
            this.indexDirty = true;
        }
    }
    async flush() {
        if (!this.indexDirty)
            return;
        await writeJsonAtomic(this.indexPath(), {
            version: 1,
            byDedupKey: Object.fromEntries(this.index),
        });
        this.indexDirty = false;
    }
    async close() {
        if (this.state)
            return;
        if (this.db) {
            this.db.close();
            return;
        }
        await this.flush();
    }
    async migrateLegacyToState() {
        if (!this.state)
            return;
        let files = [];
        try {
            files = await readdir(join(this.dir, "tasks"));
        }
        catch {
            return;
        }
        for (const file of files) {
            if (!file.endsWith(".json") || file === "index.json")
                continue;
            try {
                const task = await readJsonFile(join(this.dir, "tasks", file), undefined);
                if (!task || typeof task.id !== "string")
                    continue;
                this.state.saveTask(task.id, JSON.stringify(task), task.updatedAt ?? Date.now(), task.dedupKey);
            }
            catch (error) {
                this.logger.warn("legacy task migration skipped", { file, error: toErrorMessage(error) });
            }
        }
        this.state.markLegacyTasksImported();
    }
    async migrateLegacyToDb() {
        if (!this.db)
            return;
        let files = [];
        try {
            files = await readdir(join(this.dir, "tasks"));
        }
        catch {
            return;
        }
        for (const file of files) {
            if (!file.endsWith(".json") || file === "index.json")
                continue;
            try {
                const task = await readJsonFile(join(this.dir, "tasks", file), undefined);
                if (!task || typeof task.id !== "string")
                    continue;
                this.db.prepare("INSERT OR IGNORE INTO tasks(task_id, data, updated_at) VALUES (?, ?, ?)")
                    .run(task.id, JSON.stringify(task), task.updatedAt ?? Date.now());
                this.db.prepare("INSERT OR IGNORE INTO task_index(dedup_key, task_id) VALUES (?, ?)")
                    .run(task.dedupKey, task.id);
            }
            catch (error) {
                this.logger.warn("legacy task migration skipped", { file, error: toErrorMessage(error) });
            }
        }
    }
}
//# sourceMappingURL=task-store.js.map