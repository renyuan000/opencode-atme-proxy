import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "./logger.js";
import { readJsonFile, writeJsonAtomic } from "./util.js";
export class JobStore {
    dir;
    logger;
    jobs = new Map();
    ack = Promise.resolve();
    constructor(dir, logger) {
        this.dir = dir;
        this.logger = logger ?? createLogger({ scope: "jobs" });
    }
    taskDir() {
        return join(this.dir, "jobs");
    }
    async load() {
        try {
            await mkdir(this.taskDir(), { recursive: true, mode: 0o700 });
            const files = await readdir(this.taskDir());
            for (const file of files) {
                if (!file.endsWith(".json"))
                    continue;
                try {
                    const record = await readJsonFile(join(this.taskDir(), file), undefined);
                    if (record?.id && record.chatId && record.messageId) {
                        this.jobs.set(record.id, record);
                    }
                }
                catch {
                    continue;
                }
            }
        }
        catch (error) {
            this.logger.warn("failed to load jobs", {
                dir: this.dir,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    get(id) {
        return this.jobs.get(id);
    }
    list(status) {
        return [...this.jobs.values()].filter((job) => !status || job.status === status);
    }
    async save(record) {
        this.jobs.set(record.id, record);
        await this.flushOne(record);
    }
    async create(input) {
        const now = Date.now();
        const existing = this.jobs.get(input.id);
        const record = {
            ...input,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
            attempts: existing?.attempts ?? 0,
        };
        await this.save(record);
        return record;
    }
    async update(id, patch) {
        const record = this.jobs.get(id);
        if (!record)
            return undefined;
        Object.assign(record, patch, { updatedAt: Date.now() });
        await this.flushOne(record);
        return record;
    }
    async flushOne(record) {
        this.ack = this.ack
            .catch(() => { })
            .then(async () => {
            await mkdir(this.taskDir(), { recursive: true, mode: 0o700 });
            await writeJsonAtomic(join(this.taskDir(), `${record.id}.json`), record);
        })
            .catch((error) => {
            this.logger.warn("failed to persist job", {
                jobId: record.id,
                error: error instanceof Error ? error.message : String(error),
            });
        });
        await this.ack;
    }
    async flush() {
        await this.ack;
    }
}
//# sourceMappingURL=job-store.js.map