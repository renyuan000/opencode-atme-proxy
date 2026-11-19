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
        for (const [ownerId, target] of Object.entries(data.targets ?? {})) {
            if (target && typeof target.chatId === "string" && typeof target.updatedAt === "number") {
                this.targets.set(ownerId, { ...target, ownerId });
            }
        }
    }
    get(ownerId, maxAgeMs = 4 * 3600_000) {
        const target = this.targets.get(ownerId);
        if (!target)
            return undefined;
        if (Date.now() - target.updatedAt > maxAgeMs) {
            this.targets.delete(ownerId);
            this.dirty = true;
            return undefined;
        }
        return target;
    }
    set(target) {
        this.targets.set(target.ownerId, target);
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