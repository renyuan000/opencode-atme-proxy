import { readFile } from "node:fs/promises";
import { createLogger } from "./logger.js";
import { readJsonFile, writeJsonAtomic, isMissingFile, toErrorMessage } from "./util.js";
export class DedupStore {
    options;
    entries = new Map();
    dirty = false;
    flushing;
    now;
    logger;
    constructor(options) {
        this.options = options;
        this.now = options.now ?? Date.now;
        this.logger = options.logger ?? createLogger({ scope: "dedup" });
    }
    async load() {
        try {
            const data = await readJsonFile(this.options.file, { version: 1, entries: {} });
            for (const [key, timestamp] of Object.entries(data.entries ?? {})) {
                if (typeof timestamp === "number" && this.now() - timestamp <= this.options.ttlMs) {
                    this.entries.set(key, timestamp);
                }
            }
        }
        catch (error) {
            if (!isMissingFile(error)) {
                await this.quarantine(error);
            }
            this.entries.clear();
        }
    }
    async quarantine(error) {
        const backup = `${this.options.file}.corrupt.${Date.now()}`;
        try {
            const raw = await readFile(this.options.file, "utf8");
            await writeJsonAtomic(backup, { raw, error: toErrorMessage(error) });
        }
        catch {
            // Best effort.
        }
        this.logger.error("dedup store corrupted; starting empty", {
            file: this.options.file,
            backup,
            error: toErrorMessage(error),
        });
    }
    has(key) {
        const timestamp = this.entries.get(key);
        if (timestamp === undefined)
            return false;
        if (this.now() - timestamp > this.options.ttlMs) {
            this.entries.delete(key);
            this.dirty = true;
            return false;
        }
        return true;
    }
    add(key) {
        const timestamp = this.now();
        this.entries.set(key, timestamp);
        this.dirty = true;
        if (this.entries.size > this.options.maxEntries)
            this.prune();
    }
    delete(key) {
        if (this.entries.delete(key))
            this.dirty = true;
    }
    prune() {
        const now = this.now();
        for (const [key, timestamp] of this.entries) {
            if (now - timestamp > this.options.ttlMs) {
                this.entries.delete(key);
                this.dirty = true;
            }
        }
        if (this.entries.size > this.options.maxEntries) {
            const sorted = [...this.entries.entries()].sort((a, b) => a[1] - b[1]);
            const excess = this.entries.size - this.options.maxEntries;
            for (let index = 0; index < excess; index++) {
                const entry = sorted[index];
                if (!entry)
                    break;
                this.entries.delete(entry[0]);
                this.dirty = true;
            }
        }
    }
    size() {
        return this.entries.size;
    }
    async flush() {
        if (!this.dirty)
            return;
        if (this.flushing) {
            await this.flushing;
            if (!this.dirty)
                return;
        }
        this.flushing = this.writeSnapshot();
        try {
            await this.flushing;
        }
        finally {
            this.flushing = undefined;
        }
    }
    async writeSnapshot() {
        this.prune();
        await writeJsonAtomic(this.options.file, {
            version: 1,
            entries: Object.fromEntries(this.entries),
        });
        this.dirty = false;
    }
    async close() {
        await this.flush();
    }
}
//# sourceMappingURL=dedup.js.map