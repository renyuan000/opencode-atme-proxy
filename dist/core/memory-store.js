import { createLogger } from "./logger.js";
import { readJsonFile, writeJsonAtomic, sha256, toErrorMessage, truncate } from "./util.js";
export class MemoryStore {
    options;
    entries = new Map();
    dirty = false;
    logger;
    now;
    pinnedKinds;
    constructor(options) {
        this.options = options;
        this.logger = options.logger ?? createLogger({ scope: "memory" });
        this.now = options.now ?? Date.now;
        this.pinnedKinds = new Set(options.pinnedKinds);
    }
    async load() {
        try {
            const data = await readJsonFile(this.options.file, { version: 1, entries: {} });
            const now = this.now();
            for (const [id, entry] of Object.entries(data.entries ?? {})) {
                if (!entry || typeof entry.value !== "string")
                    continue;
                if (!entry.pinned && entry.expiresAt !== undefined && entry.expiresAt <= now)
                    continue;
                this.entries.set(id, entry);
            }
            this.prune();
        }
        catch (error) {
            this.logger.error("failed to load memory; starting empty", {
                error: toErrorMessage(error),
            });
        }
    }
    upsert(input) {
        const id = sha256(`${input.platform}:${input.key}`).slice(0, 20);
        const now = this.now();
        const existing = this.entries.get(id);
        const pinned = Boolean(input.pinned || this.pinnedKinds.has(input.kind));
        const expiresAt = pinned
            ? undefined
            : input.ttlMs !== undefined
                ? now + input.ttlMs
                : existing?.expiresAt ?? now + this.options.ttlMs;
        const record = {
            id,
            platform: input.platform,
            ...(input.chatId ? { chatId: input.chatId } : {}),
            ...(input.projectId ? { projectId: input.projectId } : {}),
            kind: input.kind,
            key: input.key,
            value: truncate(input.value, 1000),
            sourceMessageIds: unique([
                ...(existing?.sourceMessageIds ?? []),
                ...(input.sourceMessageIds ?? []),
            ]).slice(-20),
            tags: unique([...(existing?.tags ?? []), ...(input.tags ?? [])]).slice(-20),
            confidence: input.confidence ?? existing?.confidence ?? 0.8,
            pinned: pinned || Boolean(existing?.pinned),
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
            ...(expiresAt !== undefined ? { expiresAt } : {}),
        };
        this.entries.set(id, record);
        this.dirty = true;
        if (this.entries.size > this.options.maxEntries)
            this.prune();
        return record;
    }
    get(id) {
        return this.entries.get(id);
    }
    delete(id) {
        const removed = this.entries.delete(id);
        if (removed)
            this.dirty = true;
        return removed;
    }
    query(input) {
        const now = this.now();
        const terms = tokenize(input.text ?? "");
        const scored = [];
        for (const record of this.entries.values()) {
            if (record.platform !== input.platform)
                continue;
            if (!record.pinned && record.expiresAt !== undefined && record.expiresAt <= now)
                continue;
            if (record.chatId && input.chatId && record.chatId !== input.chatId)
                continue;
            if (record.projectId && input.projectId && record.projectId !== input.projectId)
                continue;
            let score = record.pinned ? 100 : 0;
            if (record.chatId && record.chatId === input.chatId)
                score += 20;
            if (record.projectId && record.projectId === input.projectId)
                score += 15;
            score += recencyScore(record.updatedAt, now, 30);
            if (terms.length > 0) {
                const haystack = `${record.key}\n${record.value}\n${record.tags.join(" ")}`.toLowerCase();
                for (const term of terms) {
                    if (haystack.includes(term))
                        score += 10;
                }
                if (score < 10 && !record.pinned && record.kind !== "decision")
                    continue;
            }
            scored.push({ record, score });
        }
        scored.sort((a, b) => b.score - a.score || b.record.updatedAt - a.record.updatedAt);
        return scored.slice(0, input.limit).map((item) => item.record);
    }
    prune() {
        const now = this.now();
        for (const [id, record] of this.entries) {
            if (!record.pinned && record.expiresAt !== undefined && record.expiresAt <= now) {
                this.entries.delete(id);
                this.dirty = true;
            }
        }
        if (this.entries.size <= this.options.maxEntries)
            return;
        const sorted = [...this.entries.values()].sort((a, b) => {
            if (a.pinned !== b.pinned)
                return a.pinned ? -1 : 1;
            return a.updatedAt - b.updatedAt;
        });
        const excess = this.entries.size - this.options.maxEntries;
        for (let index = 0; index < excess; index++) {
            const record = sorted[index];
            if (!record)
                break;
            if (record.pinned)
                break;
            this.entries.delete(record.id);
            this.dirty = true;
        }
    }
    size() {
        return this.entries.size;
    }
    async flush() {
        if (!this.dirty)
            return;
        this.prune();
        await writeJsonAtomic(this.options.file, {
            version: 1,
            entries: Object.fromEntries(this.entries),
        });
        this.dirty = false;
    }
}
function tokenize(text) {
    return text
        .toLowerCase()
        .split(/[\s,，。；;、:：!！?？()[\]{}"'`]+/)
        .map((item) => item.trim())
        .filter((item) => item.length >= 2)
        .slice(0, 12);
}
function recencyScore(updatedAt, now, days) {
    const ageDays = (now - updatedAt) / 86_400_000;
    if (ageDays < 0)
        return 10;
    if (ageDays > days)
        return 0;
    return 10 * (1 - ageDays / days);
}
function unique(values) {
    return [...new Set(values.filter(Boolean))];
}
//# sourceMappingURL=memory-store.js.map