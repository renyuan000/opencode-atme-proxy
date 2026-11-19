import { createLogger } from "./logger.js";
import { readJsonFile, writeJsonAtomic } from "./util.js";
export class OwnerTargetStore {
    file;
    targets = new Map();
    dirty = false;
    logger;
    constructor(file, logger) {
        this.file = file;
        this.logger = logger ?? createLogger({ scope: "owner-target" });
    }
    async load() {
        const data = await readJsonFile(this.file, { version: 1, targets: {} });
        for (const [ownerId, value] of Object.entries(data.targets ?? {})) {
            const list = Array.isArray(value) ? value : [value];
            const valid = list
                .filter((target) => target && typeof target.chatId === "string")
                .map((target) => ({ ...target, ownerId }));
            if (valid.length > 0)
                this.targets.set(ownerId, valid.slice(0, 5));
        }
    }
    list(ownerId, maxAgeMs = 4 * 3600_000) {
        const now = Date.now();
        const list = (this.targets.get(ownerId) ?? []).filter((target) => now - target.updatedAt <= maxAgeMs);
        if (list.length !== (this.targets.get(ownerId)?.length ?? 0)) {
            this.targets.set(ownerId, list);
            this.dirty = true;
        }
        return list;
    }
    get(ownerId, maxAgeMs = 4 * 3600_000) {
        return this.list(ownerId, maxAgeMs)[0];
    }
    set(target) {
        const current = this.targets.get(target.ownerId) ?? [];
        const next = [
            target,
            ...current.filter((item) => item.chatId !== target.chatId ||
                (item.sourceMessageId ?? "") !== (target.sourceMessageId ?? "")),
        ].slice(0, 5);
        this.targets.set(target.ownerId, next);
        this.dirty = true;
    }
    clear(ownerId) {
        if (this.targets.delete(ownerId))
            this.dirty = true;
    }
    async flush() {
        if (!this.dirty)
            return;
        await writeJsonAtomic(this.file, {
            version: 1,
            targets: Object.fromEntries(this.targets),
        });
        this.dirty = false;
    }
}
//# sourceMappingURL=owner-target.js.map