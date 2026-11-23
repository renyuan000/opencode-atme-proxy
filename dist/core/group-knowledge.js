import { appendFile } from "node:fs/promises";
import { createLogger } from "./logger.js";
import { readJsonFile, writeJsonAtomic } from "./util.js";
function normalizeKnowledge(raw, info) {
    const stringArray = (value) => Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
    const terms = raw.terms && typeof raw.terms === "object" && !Array.isArray(raw.terms)
        ? Object.fromEntries(Object.entries(raw.terms).filter((entry) => typeof entry[1] === "string"))
        : {};
    return {
        chatId: info.chatId,
        name: typeof raw.name === "string" && raw.name ? raw.name : info.name,
        product: typeof raw.product === "string" ? raw.product : "",
        summary: typeof raw.summary === "string" ? raw.summary : "",
        features: stringArray(raw.features),
        tasks: stringArray(raw.tasks),
        dependsOn: stringArray(raw.dependsOn),
        excludes: stringArray(raw.excludes),
        terms,
        ownerDirection: typeof raw.ownerDirection === "string" ? raw.ownerDirection : "",
        ownerKeywords: stringArray(raw.ownerKeywords),
        sessionEpoch: typeof raw.sessionEpoch === "number" && Number.isFinite(raw.sessionEpoch)
            ? Math.max(1, Math.floor(raw.sessionEpoch))
            : 1,
        source: raw.source === "owner" ? "owner" : "inferred",
        confidence: typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
            ? Math.min(1, Math.max(0, raw.confidence))
            : 0,
        updatedAt: typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt)
            ? raw.updatedAt
            : Date.now(),
    };
}
export class ScopedGroupKnowledge {
    layout;
    logger;
    profiles = new Map();
    constructor(layout, logger) {
        this.layout = layout;
        this.logger = logger ?? createLogger({ scope: "group-knowledge" });
    }
    async load() {
        for (const info of this.layout.all()) {
            try {
                const stored = await readJsonFile(`${info.dir}/group-knowledge.json`, undefined);
                const legacy = stored
                    ? undefined
                    : await readJsonFile(`${info.dir}/group-profile.json`, undefined);
                const raw = stored ?? legacy;
                if (raw?.chatId === info.chatId) {
                    const profile = normalizeKnowledge(raw, info);
                    this.profiles.set(info.chatId, profile);
                    if (legacy)
                        await this.set(profile);
                }
            }
            catch (error) {
                this.logger.warn("failed to load group knowledge", {
                    chatId: info.chatId,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }
    get(chatId) {
        return this.profiles.get(chatId);
    }
    async set(profile) {
        this.profiles.set(profile.chatId, profile);
        const dir = this.layout.dirFor(profile.chatId);
        await writeJsonAtomic(`${dir}/group-knowledge.json`, profile);
        try {
            await appendFile(`${dir}/group-knowledge-history.jsonl`, `${JSON.stringify({ at: profile.updatedAt, ...profile })}\n`, { encoding: "utf8", mode: 0o600 });
        }
        catch (error) {
            this.logger.warn("failed to append group knowledge history", {
                chatId: profile.chatId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    list() {
        return [...this.profiles.values()];
    }
    async bumpSessionEpoch(chatId) {
        const existing = this.profiles.get(chatId);
        if (!existing)
            return 1;
        const next = { ...existing, sessionEpoch: existing.sessionEpoch + 1, updatedAt: Date.now() };
        await this.set(next);
        return next.sessionEpoch;
    }
    async flush() {
        for (const profile of this.profiles.values()) {
            await writeJsonAtomic(`${this.layout.dirFor(profile.chatId)}/group-knowledge.json`, profile);
        }
    }
}
//# sourceMappingURL=group-knowledge.js.map