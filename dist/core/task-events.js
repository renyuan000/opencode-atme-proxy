import { join } from "node:path";
import { TaskStateDb } from "./task-state-db.js";
import { createLogger } from "./logger.js";
import { sha256, toErrorMessage } from "./util.js";
export class TaskEventBus {
    handlers = new Map();
    logger;
    constructor(logger) {
        this.logger = logger ?? createLogger({ scope: "task-events" });
    }
    on(type, handler) {
        const set = this.handlers.get(type) ?? new Set();
        set.add(handler);
        this.handlers.set(type, set);
    }
    async publish(event) {
        const value = {
            ...event,
            eventId: event.eventId ?? sha256(`${event.type}:${event.taskId}:${Date.now()}:${Math.random()}`).slice(0, 16),
            at: event.at ?? Date.now(),
        };
        for (const handler of this.handlers.get(value.type) ?? []) {
            try {
                await handler(value);
            }
            catch (error) {
                this.logger.warn("task event handler failed", {
                    type: value.type,
                    taskId: value.taskId,
                    error: toErrorMessage(error),
                });
            }
        }
        return value;
    }
}
export class ScopedTaskEvents {
    layout;
    logger;
    dbFor;
    stores = new Map();
    constructor(layout, logger = createLogger({ scope: "task-events" }), dbFor) {
        this.layout = layout;
        this.logger = logger;
        this.dbFor = dbFor;
    }
    store(chatId) {
        const existing = this.stores.get(chatId);
        if (existing)
            return existing;
        const store = this.dbFor?.(chatId) ?? new TaskStateDb(join(this.layout.dirFor(chatId), "cache", "state.db"), chatId, this.logger.child(chatId));
        this.stores.set(chatId, store);
        return store;
    }
    async publish(chatId, event) {
        const value = {
            ...event,
            eventId: sha256(`${event.type}:${event.taskId}:${Date.now()}:${Math.random()}`).slice(0, 16),
            at: Date.now(),
        };
        this.store(chatId).publish(value);
        return value;
    }
    close() {
        if (this.dbFor) {
            this.stores.clear();
            return;
        }
        for (const store of this.stores.values())
            store.close();
        this.stores.clear();
    }
}
//# sourceMappingURL=task-events.js.map