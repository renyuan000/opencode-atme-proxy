import { appendFile } from "node:fs/promises";
import { createLogger } from "./logger.js";
import { readJsonFile, writeJsonAtomic } from "./util.js";
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
                let profile = await readJsonFile(`${info.dir}/group-knowledge.json`, undefined);
                if (!profile) {
                    profile = await readJsonFile(`${info.dir}/group-profile.json`, undefined);
                    if (profile)
                        await this.set(profile);
                }
                if (profile?.chatId === info.chatId)
                    this.profiles.set(info.chatId, profile);
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
    async flush() {
        for (const profile of this.profiles.values()) {
            await writeJsonAtomic(`${this.layout.dirFor(profile.chatId)}/group-knowledge.json`, profile);
        }
    }
}
//# sourceMappingURL=group-knowledge.js.map