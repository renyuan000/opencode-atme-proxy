import { join } from "node:path";
import { TaskStateDb } from "./task-state-db.js";
import type { GroupStateLayout } from "./group-state.js";
import type { Logger } from "./logger.js";
import { createLogger } from "./logger.js";
import { sha256, toErrorMessage } from "./util.js";

export type TaskEventType =
  | "task.created"
  | "task.supplement"
  | "analysis.started"
  | "analysis.completed"
  | "analysis.failed"
  | "approval.sent"
  | "execution.started"
  | "execution.completed"
  | "review.completed"
  | "task.archived"
  | "task.reanalyze_requested";

export interface TaskEvent {
  eventId: string;
  type: TaskEventType;
  taskId: string;
  chatId: string;
  at: number;
  payload?: Record<string, unknown>;
}

export type TaskEventHandler = (event: TaskEvent) => void | Promise<void>;

export class TaskEventBus {
  private readonly handlers = new Map<string, Set<TaskEventHandler>>();
  private readonly logger: Logger;

  constructor(logger?: Logger) {
    this.logger = logger ?? createLogger({ scope: "task-events" });
  }

  on(type: TaskEventType, handler: TaskEventHandler): void {
    const set = this.handlers.get(type) ?? new Set<TaskEventHandler>();
    set.add(handler);
    this.handlers.set(type, set);
  }

  async publish(event: Omit<TaskEvent, "eventId" | "at"> & Partial<Pick<TaskEvent, "eventId" | "at">>): Promise<TaskEvent> {
    const value: TaskEvent = {
      ...event,
      eventId: event.eventId ?? sha256(`${event.type}:${event.taskId}:${Date.now()}:${Math.random()}`).slice(0, 16),
      at: event.at ?? Date.now(),
    };
    for (const handler of this.handlers.get(value.type) ?? []) {
      try {
        await handler(value);
      } catch (error) {
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
  private readonly stores = new Map<string, TaskStateDb>();

  constructor(
    private readonly layout: GroupStateLayout,
    private readonly logger: Logger = createLogger({ scope: "task-events" }),
    private readonly dbFor?: (chatId: string) => TaskStateDb,
  ) {}

  private store(chatId: string): TaskStateDb {
    const existing = this.stores.get(chatId);
    if (existing) return existing;
    const store = this.dbFor?.(chatId) ?? new TaskStateDb(
      join(this.layout.dirFor(chatId), "cache", "state.db"),
      chatId,
      this.logger.child(chatId),
    );
    this.stores.set(chatId, store);
    return store;
  }

  async publish(chatId: string, event: Omit<TaskEvent, "eventId" | "at">): Promise<TaskEvent> {
    const value: TaskEvent = {
      ...event,
      eventId: sha256(`${event.type}:${event.taskId}:${Date.now()}:${Math.random()}`).slice(0, 16),
      at: Date.now(),
    };
    this.store(chatId).publish(value);
    return value;
  }

  close(): void {
    if (this.dbFor) {
      this.stores.clear();
      return;
    }
    for (const store of this.stores.values()) store.close();
    this.stores.clear();
  }
}
