import { createLogger } from "./logger.js";
import { readJsonFile, writeJsonAtomic, toErrorMessage } from "./util.js";
export class CursorStore {
    options;
    cursors = new Map();
    dirty = false;
    logger;
    now;
    constructor(options) {
        this.options = options;
        this.logger = options.logger ?? createLogger({ scope: "cursor" });
        this.now = options.now ?? Date.now;
    }
    async load() {
        try {
            const data = await readJsonFile(this.options.file, {
                version: 1,
                cursors: {},
            });
            for (const [key, value] of Object.entries(data.cursors ?? {})) {
                if (value &&
                    typeof value.lastEndTime === "number" &&
                    typeof value.updatedAt === "number") {
                    this.cursors.set(key, value);
                }
            }
        }
        catch (error) {
            this.logger.error("failed to load cursors; starting empty", {
                error: toErrorMessage(error),
            });
        }
    }
    get(chatId) {
        return this.cursors.get(chatId)?.lastEndTime;
    }
    record(chatId) {
        return this.cursors.get(chatId);
    }
    set(chatId, lastEndTime, last) {
        const existing = this.cursors.get(chatId);
        this.cursors.set(chatId, {
            lastEndTime,
            updatedAt: this.now(),
            ...(last?.messageId ?? existing?.lastMessageId
                ? { lastMessageId: last?.messageId ?? existing?.lastMessageId }
                : {}),
            ...(last?.messageTime ?? existing?.lastMessageTime
                ? { lastMessageTime: last?.messageTime ?? existing?.lastMessageTime }
                : {}),
        });
        this.dirty = true;
    }
    async flush() {
        if (!this.dirty)
            return;
        await writeJsonAtomic(this.options.file, {
            version: 1,
            cursors: Object.fromEntries(this.cursors),
        });
        this.dirty = false;
    }
}
//# sourceMappingURL=cursor.js.map