import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "./logger.js";
import { readJsonFile, writeJsonAtomic, toErrorMessage } from "./util.js";
export class TaskStore {
    dir;
    index = new Map();
    logger;
    indexDirty = false;
    constructor(dir, logger) {
        this.dir = dir;
        this.logger = logger ?? createLogger({ scope: "tasks" });
    }
    taskPath(taskId) {
        return join(this.dir, "tasks", `${taskId}.json`);
    }
    indexPath() {
        return join(this.dir, "tasks", "index.json");
    }
    async load() {
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
    async list() {
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
            this.logger.error("failed to list tasks", { error: toErrorMessage(error) });
            return [];
        }
    }
    async save(task) {
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
        await this.flush();
    }
}
//# sourceMappingURL=task-store.js.map