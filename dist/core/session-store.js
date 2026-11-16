import { createLogger } from "./logger.js";
import { readJsonFile, writeJsonAtomic, toErrorMessage } from "./util.js";
export class SessionStore {
    file;
    sessions = new Map();
    dirty = false;
    logger;
    constructor(file, logger) {
        this.file = file;
        this.logger = logger ?? createLogger({ scope: "sessions" });
    }
    async load() {
        try {
            const data = await readJsonFile(this.file, { version: 1, sessions: {} });
            for (const [key, value] of Object.entries(data.sessions ?? {})) {
                if (value && typeof value.sessionId === "string") {
                    this.sessions.set(key, {
                        sessionId: value.sessionId,
                        directory: typeof value.directory === "string" ? value.directory : "",
                        updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
                        createdAt: typeof value.createdAt === "number"
                            ? value.createdAt
                            : typeof value.updatedAt === "number"
                                ? value.updatedAt
                                : 0,
                        kind: value.kind === "child" ? "child" : "coordinator",
                        ...(typeof value.taskId === "string" ? { taskId: value.taskId } : {}),
                        ...(typeof value.archivedAt === "number" ? { archivedAt: value.archivedAt } : {}),
                    });
                }
            }
        }
        catch (error) {
            this.logger.error("failed to load sessions; starting empty", {
                error: toErrorMessage(error),
            });
        }
    }
    get(key) {
        return this.sessions.get(key);
    }
    set(key, sessionId, directory, meta) {
        const now = Date.now();
        const existing = this.sessions.get(key);
        this.sessions.set(key, {
            sessionId,
            directory,
            updatedAt: now,
            createdAt: meta?.createdAt ?? existing?.createdAt ?? now,
            kind: meta?.kind ?? existing?.kind ?? "coordinator",
            ...(meta?.taskId ?? existing?.taskId ? { taskId: meta?.taskId ?? existing?.taskId } : {}),
            ...(meta?.archivedAt ?? existing?.archivedAt
                ? { archivedAt: meta?.archivedAt ?? existing?.archivedAt }
                : {}),
        });
        this.dirty = true;
    }
    list(kind) {
        const entries = [...this.sessions.entries()];
        return kind ? entries.filter(([, record]) => record.kind === kind) : entries;
    }
    delete(key) {
        if (this.sessions.delete(key))
            this.dirty = true;
    }
    findByTask(taskId, kind = "child") {
        return [...this.sessions.entries()].filter(([, record]) => record.kind === kind && record.taskId === taskId);
    }
    async flush() {
        if (!this.dirty)
            return;
        await writeJsonAtomic(this.file, {
            version: 1,
            sessions: Object.fromEntries(this.sessions),
        });
        this.dirty = false;
    }
}
//# sourceMappingURL=session-store.js.map