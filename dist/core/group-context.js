import { createLogger } from "./logger.js";
import { readJsonFile, writeJsonAtomic, toErrorMessage } from "./util.js";
export class GroupContextStore {
    file;
    chats = new Map();
    dirty = false;
    logger;
    constructor(file, logger) {
        this.file = file;
        this.logger = logger ?? createLogger({ scope: "group-context" });
    }
    async load() {
        try {
            const data = await readJsonFile(this.file, { version: 1, chats: {} });
            for (const [chatId, summary] of Object.entries(data.chats ?? {})) {
                if (summary && typeof summary.summary === "string") {
                    this.chats.set(chatId, summary);
                }
            }
        }
        catch (error) {
            this.logger.error("failed to load group context; starting empty", {
                error: toErrorMessage(error),
            });
        }
    }
    get(chatId) {
        return this.chats.get(chatId);
    }
    set(chatId, summary) {
        this.chats.set(chatId, summary);
        this.dirty = true;
    }
    async flush() {
        if (!this.dirty)
            return;
        await writeJsonAtomic(this.file, {
            version: 1,
            chats: Object.fromEntries(this.chats),
        });
        this.dirty = false;
    }
    size() {
        return this.chats.size;
    }
    list() {
        return [...this.chats.values()];
    }
}
//# sourceMappingURL=group-context.js.map