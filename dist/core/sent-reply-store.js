import { createLogger } from "./logger.js";
import { readJsonFile, writeJsonAtomic } from "./util.js";
export class SentReplyStore {
    file;
    ttlMs;
    maxEntries;
    logger;
    replies = [];
    chain = Promise.resolve();
    constructor(file, ttlMs = 7 * 24 * 3600_000, maxEntries = 50, logger) {
        this.file = file;
        this.ttlMs = ttlMs;
        this.maxEntries = maxEntries;
        this.logger = logger ?? createLogger({ scope: "sent-replies" });
    }
    async load() {
        try {
            const data = await readJsonFile(this.file, {
                version: 1,
                replies: [],
            });
            const cutoff = Date.now() - this.ttlMs;
            this.replies = (Array.isArray(data.replies) ? data.replies : [])
                .filter((item) => Boolean(item) &&
                typeof item.id === "string" &&
                typeof item.chatId === "string" &&
                typeof item.sentMessageId === "string" &&
                typeof item.text === "string" &&
                typeof item.sentAt === "number" &&
                item.sentAt >= cutoff)
                .slice(0, this.maxEntries);
        }
        catch (error) {
            this.replies = [];
            this.logger.error("failed to load sent replies; starting empty", {
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    list(limit = 5) {
        return this.replies.slice(0, Math.max(0, limit));
    }
    listRecallable(limit = 5, now = Date.now()) {
        const windowMs = 24 * 3600_000;
        return this.replies
            .filter((item) => item.status === "sent" && now - item.sentAt <= windowMs)
            .slice(0, Math.max(0, limit));
    }
    get(id) {
        return this.replies.find((item) => item.id === id);
    }
    hasSource(sourceMessageId) {
        return this.replies.some((item) => item.status === "sent" && item.sourceMessageId === sourceMessageId);
    }
    listBySource(sourceMessageId) {
        return this.replies.filter((item) => item.status === "sent" && item.sourceMessageId === sourceMessageId);
    }
    async add(input) {
        const record = {
            ...input,
            id: `sent_${input.sentMessageId.slice(-12)}_${input.sentAt}`,
            status: "sent",
        };
        this.replies = [
            record,
            ...this.replies.filter((item) => item.sentMessageId !== record.sentMessageId),
        ].slice(0, this.maxEntries);
        await this.flush();
        return record;
    }
    async markRecalled(id, at = Date.now()) {
        const record = this.get(id);
        if (!record || record.status === "recalled")
            return false;
        record.status = "recalled";
        record.recalledAt = at;
        await this.flush();
        return true;
    }
    async flush() {
        this.chain = this.chain
            .catch(() => { })
            .then(async () => {
            await writeJsonAtomic(this.file, {
                version: 1,
                replies: this.replies,
            });
        })
            .catch((error) => {
            this.logger.error("failed to persist sent replies", {
                error: error instanceof Error ? error.message : String(error),
            });
        });
        await this.chain;
    }
}
//# sourceMappingURL=sent-reply-store.js.map