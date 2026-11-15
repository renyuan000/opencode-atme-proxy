import { createLogger } from "./logger.js";
import { readJsonFile, writeJsonAtomic, toErrorMessage } from "./util.js";
export class OwnerStore {
    file;
    owners = new Map();
    dirty = false;
    logger;
    constructor(file, logger) {
        this.file = file;
        this.logger = logger ?? createLogger({ scope: "owner" });
    }
    async load() {
        try {
            const data = await readJsonFile(this.file, { version: 1, owners: {} });
            for (const [platform, binding] of Object.entries(data.owners ?? {})) {
                if (binding && typeof binding.openId === "string" && binding.openId) {
                    this.owners.set(platform, binding);
                }
            }
        }
        catch (error) {
            this.logger.error("failed to load owner binding; starting empty", {
                error: toErrorMessage(error),
            });
        }
    }
    get(platform) {
        return this.owners.get(platform);
    }
    set(binding) {
        this.owners.set(binding.platform, binding);
        this.dirty = true;
    }
    clear(platform) {
        const removed = this.owners.delete(platform);
        if (removed)
            this.dirty = true;
        return removed;
    }
    async flush() {
        if (!this.dirty)
            return;
        await writeJsonAtomic(this.file, {
            version: 1,
            owners: Object.fromEntries(this.owners),
        });
        this.dirty = false;
    }
}
//# sourceMappingURL=owner-store.js.map