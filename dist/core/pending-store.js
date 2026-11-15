import { createLogger } from "./logger.js";
import { readJsonFile, writeJsonAtomic, toErrorMessage } from "./util.js";
export class PendingStore {
    file;
    cards = new Map();
    dirty = false;
    logger;
    constructor(file, logger) {
        this.file = file;
        this.logger = logger ?? createLogger({ scope: "pending" });
    }
    async load() {
        try {
            const data = await readJsonFile(this.file, { version: 1, cards: {} });
            for (const [key, card] of Object.entries(data.cards ?? {})) {
                if (card && typeof card.taskId === "string" && typeof card.planHash === "string") {
                    this.cards.set(key, card);
                }
            }
        }
        catch (error) {
            this.logger.error("failed to load pending cards; starting empty", {
                error: toErrorMessage(error),
            });
        }
    }
    get(key) {
        return this.cards.get(key);
    }
    findForTask(taskId) {
        for (const card of this.cards.values()) {
            if (card.taskId === taskId)
                return card;
        }
        return undefined;
    }
    set(key, card) {
        this.cards.set(key, card);
        this.dirty = true;
    }
    delete(key) {
        if (this.cards.delete(key))
            this.dirty = true;
    }
    snapshot() {
        return [...this.cards.entries()];
    }
    deleteForTask(taskId) {
        for (const [key, card] of this.cards) {
            if (card.taskId === taskId) {
                this.cards.delete(key);
                this.dirty = true;
            }
        }
    }
    async flush() {
        if (!this.dirty)
            return;
        await writeJsonAtomic(this.file, {
            version: 1,
            cards: Object.fromEntries(this.cards),
        });
        this.dirty = false;
    }
}
//# sourceMappingURL=pending-store.js.map