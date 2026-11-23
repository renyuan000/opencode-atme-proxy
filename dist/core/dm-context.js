import { createLogger } from "./logger.js";
import { readJsonFile, writeJsonAtomic } from "./util.js";
function stringArray(value) {
    return Array.isArray(value)
        ? value.filter((item) => typeof item === "string" && item.trim().length > 0)
        : [];
}
function normalize(raw, chatId) {
    if (!raw || raw.chatId !== chatId)
        return undefined;
    return {
        chatId,
        summary: typeof raw.summary === "string" ? raw.summary : "",
        preferences: stringArray(raw.preferences),
        decisions: stringArray(raw.decisions),
        ongoingGoals: stringArray(raw.ongoingGoals),
        openQuestions: stringArray(raw.openQuestions),
        lastMessageAt: typeof raw.lastMessageAt === "number" && Number.isFinite(raw.lastMessageAt)
            ? raw.lastMessageAt
            : 0,
        updatedAt: typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt)
            ? raw.updatedAt
            : Date.now(),
        sessionEpoch: typeof raw.sessionEpoch === "number" && Number.isFinite(raw.sessionEpoch)
            ? Math.max(1, Math.floor(raw.sessionEpoch))
            : 1,
    };
}
export class DmContextStore {
    file;
    conversations = new Map();
    dirty = false;
    logger;
    constructor(file, logger) {
        this.file = file;
        this.logger = logger ?? createLogger({ scope: "dm-context" });
    }
    async load() {
        try {
            const data = await readJsonFile(this.file, {
                version: 1,
                conversations: {},
            });
            for (const [chatId, raw] of Object.entries(data.conversations ?? {})) {
                const context = normalize(raw, chatId);
                if (context)
                    this.conversations.set(chatId, context);
            }
        }
        catch (error) {
            this.logger.error("failed to load dm context; starting empty", {
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    get(chatId) {
        return this.conversations.get(chatId);
    }
    set(context) {
        this.conversations.set(context.chatId, context);
        this.dirty = true;
    }
    async flush() {
        if (!this.dirty)
            return;
        await writeJsonAtomic(this.file, {
            version: 1,
            conversations: Object.fromEntries(this.conversations),
        });
        this.dirty = false;
    }
}
export class ScopedDmContext {
    layout;
    stores = new Map();
    logger;
    constructor(layout, logger) {
        this.layout = layout;
        this.logger = logger ?? createLogger({ scope: "dm-context" });
    }
    async load() {
        for (const info of this.layout.all()) {
            const store = this.store(info.chatId);
            await store.load();
        }
    }
    get(chatId) {
        return this.store(chatId).get(chatId);
    }
    set(context) {
        this.store(context.chatId).set(context);
    }
    async flush() {
        await Promise.all([...this.stores.values()].map((store) => store.flush()));
    }
    store(chatId) {
        const existing = this.stores.get(chatId);
        if (existing)
            return existing;
        const store = new DmContextStore(`${this.layout.dirFor(chatId)}/dm-context.json`, this.logger);
        this.stores.set(chatId, store);
        return store;
    }
}
//# sourceMappingURL=dm-context.js.map