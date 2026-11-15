import { createLogger } from "./logger.js";
import { readJsonFile, writeJsonAtomic, toErrorMessage } from "./util.js";
export class ProjectStore {
    file;
    chats = new Map();
    dirty = false;
    logger;
    constructor(file, logger) {
        this.file = file;
        this.logger = logger ?? createLogger({ scope: "projects" });
    }
    async load() {
        try {
            const data = await readJsonFile(this.file, { version: 1, chats: {} });
            for (const [chatId, value] of Object.entries(data.chats ?? {})) {
                if (value && typeof value.worktree === "string" && typeof value.projectId === "string") {
                    this.chats.set(chatId, value);
                }
            }
        }
        catch (error) {
            this.logger.error("failed to load project bindings; starting empty", {
                error: toErrorMessage(error),
            });
        }
    }
    get(chatId) {
        return this.chats.get(chatId);
    }
    set(chatId, project) {
        this.chats.set(chatId, project);
        this.dirty = true;
    }
    delete(chatId) {
        if (this.chats.delete(chatId))
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
}
//# sourceMappingURL=project-store.js.map