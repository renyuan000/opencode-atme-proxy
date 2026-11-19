import { createLogger } from "./logger.js";
import { readJsonFile, writeJsonAtomic } from "./util.js";
export class ScopedDocumentRefs {
    layout;
    ttlMs;
    logger;
    maps = new Map();
    dirty = new Set();
    constructor(layout, logger, ttlMs = 90 * 24 * 3600_000) {
        this.layout = layout;
        this.ttlMs = ttlMs;
        this.logger = logger ?? createLogger({ scope: "document-refs" });
    }
    file(chatId) {
        return `${this.layout.dirFor(chatId)}/document-refs.json`;
    }
    map(chatId) {
        const existing = this.maps.get(chatId);
        if (existing)
            return existing;
        const map = new Map();
        this.maps.set(chatId, map);
        return map;
    }
    async load() {
        for (const info of this.layout.all()) {
            try {
                const data = await readJsonFile(this.file(info.chatId), {
                    version: 1,
                    entries: {},
                });
                const cutoff = Date.now() - this.ttlMs;
                const map = new Map();
                for (const [url, ref] of Object.entries(data.entries ?? {})) {
                    if (ref && ref.seenAt >= cutoff)
                        map.set(url, ref);
                }
                this.maps.set(info.chatId, map);
            }
            catch (error) {
                this.logger.warn("failed to load document refs", {
                    chatId: info.chatId,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }
    record(chatId, input) {
        const map = this.map(chatId);
        const previous = map.get(input.url);
        map.set(input.url, {
            ...(previous ?? {}),
            url: input.url,
            ...(input.title ?? previous?.title ? { title: input.title ?? previous?.title } : {}),
            ...(input.messageId ?? previous?.messageId
                ? { messageId: input.messageId ?? previous?.messageId }
                : {}),
            ...(input.senderId ?? previous?.senderId
                ? { senderId: input.senderId ?? previous?.senderId }
                : {}),
            seenAt: Date.now(),
            status: input.status ?? previous?.status ?? "indexed",
            ...(input.status === "fetched" ? { lastFetchedAt: Date.now() } : {}),
            cached: input.cached ?? previous?.cached ?? false,
        });
        while (map.size > 200) {
            const oldest = [...map.entries()].sort((a, b) => a[1].seenAt - b[1].seenAt)[0];
            if (!oldest)
                break;
            map.delete(oldest[0]);
        }
        this.dirty.add(chatId);
    }
    list(chatId, limit = 20) {
        return [...this.map(chatId).values()]
            .sort((a, b) => b.seenAt - a.seenAt)
            .slice(0, limit);
    }
    get(chatId, url) {
        return this.map(chatId).get(url);
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
//# sourceMappingURL=document-ref-store.js.map