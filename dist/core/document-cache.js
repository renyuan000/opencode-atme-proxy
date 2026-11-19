import { createLogger } from "./logger.js";
import { readJsonFile, writeJsonAtomic } from "./util.js";
export class ScopedDocumentCache {
    layout;
    ttlMs;
    logger;
    maps = new Map();
    dirty = new Set();
    constructor(layout, logger, ttlMs = 7 * 24 * 3600_000) {
        this.layout = layout;
        this.ttlMs = ttlMs;
        this.logger = logger ?? createLogger({ scope: "document-cache" });
    }
    file(chatId) {
        return `${this.layout.dirFor(chatId)}/document-cache.json`;
    }
    map(chatId) {
        const existing = this.maps.get(chatId);
        if (existing)
            return existing;
        const created = new Map();
        this.maps.set(chatId, created);
        return created;
    }
    async load() {
        for (const info of this.layout.all()) {
            try {
                const data = await readJsonFile(this.file(info.chatId), {
                    version: 1,
                    entries: {},
                });
                const map = new Map();
                const cutoff = Date.now() - this.ttlMs;
                for (const [url, entry] of Object.entries(data.entries ?? {})) {
                    if (entry && entry.text && entry.lastUsedAt >= cutoff)
                        map.set(url, entry);
                }
                this.maps.set(info.chatId, map);
            }
            catch (error) {
                this.logger.warn("failed to load document cache", {
                    chatId: info.chatId,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }
    get(chatId, url) {
        const entry = this.map(chatId).get(url);
        if (!entry)
            return undefined;
        if (Date.now() - entry.lastUsedAt > this.ttlMs) {
            this.map(chatId).delete(url);
            this.dirty.add(chatId);
            return undefined;
        }
        entry.lastUsedAt = Date.now();
        entry.hits += 1;
        this.dirty.add(chatId);
        return entry;
    }
    set(chatId, entry) {
        const map = this.map(chatId);
        const now = Date.now();
        map.set(entry.url, { ...entry, fetchedAt: now, lastUsedAt: now, hits: 0 });
        while (map.size > 50) {
            const oldest = [...map.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
            if (!oldest)
                break;
            map.delete(oldest[0]);
        }
        this.dirty.add(chatId);
    }
    async flush() {
        for (const chatId of this.dirty) {
            await writeJsonAtomic(this.file(chatId), {
                version: 1,
                entries: Object.fromEntries(this.map(chatId)),
            });
        }
        this.dirty.clear();
    }
}
//# sourceMappingURL=document-cache.js.map