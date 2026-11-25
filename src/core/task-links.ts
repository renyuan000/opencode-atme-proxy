import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { GroupStateLayout } from "./group-state.js";
import type { Logger } from "./logger.js";
import { createLogger } from "./logger.js";
import { readJsonFile, toErrorMessage, writeJsonAtomic } from "./util.js";
import { TaskStateDb } from "./task-state-db.js";

interface TaskLinkFile {
  version: 1;
  byMessage: Record<string, string>;
  bySession: Record<string, { taskId: string; role: string }>;
}

function emptyFile(): TaskLinkFile {
  return { version: 1, byMessage: {}, bySession: {} };
}

export class TaskLinkStore {
  private file: TaskLinkFile = emptyFile();
  private dirty = false;
  private readonly logger: Logger;

  constructor(
    private readonly path: string,
    logger?: Logger,
  ) {
    this.logger = logger ?? createLogger({ scope: "task-links" });
  }

  async load(): Promise<void> {
    try {
      const data = await readJsonFile<TaskLinkFile>(this.path, emptyFile());
      this.file = {
        version: 1,
        byMessage: data.byMessage ?? {},
        bySession: data.bySession ?? {},
      };
    } catch (error) {
      this.logger.warn("failed to load task links", { path: this.path, error: toErrorMessage(error) });
      this.file = emptyFile();
    }
  }

  async linkMessage(messageId: string, taskId: string): Promise<void> {
    if (!messageId || !taskId) return;
    if (this.file.byMessage[messageId] === taskId) return;
    this.file.byMessage[messageId] = taskId;
    this.dirty = true;
    await this.flush();
  }

  async linkSession(sessionId: string, taskId: string, role: string): Promise<void> {
    if (!sessionId || !taskId) return;
    this.file.bySession[sessionId] = { taskId, role };
    this.dirty = true;
    await this.flush();
  }

  findByMessage(messageId: string): string | undefined {
    return this.file.byMessage[messageId];
  }

  findBySession(sessionId: string): { taskId: string; role: string } | undefined {
    return this.file.bySession[sessionId];
  }

  findByTask(taskId: string): Array<{ sessionId: string; role: string }> {
    return Object.entries(this.file.bySession)
      .filter(([, value]) => value.taskId === taskId)
      .map(([sessionId, value]) => ({ sessionId, role: value.role }));
  }

  snapshot(): TaskLinkFile {
    return { version: 1, byMessage: { ...this.file.byMessage }, bySession: { ...this.file.bySession } };
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    await mkdir(join(this.path, ".."), { recursive: true });
    await writeJsonAtomic(this.path, this.file);
    this.dirty = false;
  }
}

export class ScopedTaskLinks {
  private readonly stores = new Map<string, TaskStateDb>();
  private readonly logger: Logger;

  constructor(
    private readonly layout: GroupStateLayout,
    logger?: Logger,
  ) {
    this.logger = logger ?? createLogger({ scope: "task-links" });
  }

  async load(): Promise<void> {
    for (const info of this.layout.all()) this.store(info.chatId);
  }

  database(chatId: string): TaskStateDb {
    return this.store(chatId);
  }

  private store(chatId: string): TaskStateDb {
    const existing = this.stores.get(chatId);
    if (existing) return existing;
    const store = new TaskStateDb(
      join(this.layout.dirFor(chatId), "cache", "state.db"),
      chatId,
      this.logger.child(chatId),
    );
    this.stores.set(chatId, store);
    return store;
  }

  async linkMessage(chatId: string, messageId: string, taskId: string): Promise<void> {
    this.store(chatId).linkMessage(messageId, taskId);
  }

  async linkSession(chatId: string, sessionId: string, taskId: string, role: string): Promise<void> {
    this.store(chatId).linkSession(sessionId, taskId, role);
  }

  findByMessage(chatId: string, messageId: string): string | undefined {
    return this.store(chatId).findByMessage(messageId);
  }

  findByMessageAny(messageId: string): string | undefined {
    for (const store of this.stores.values()) {
      const taskId = store.findByMessage(messageId);
      if (taskId) return taskId;
    }
    return undefined;
  }

  findBySession(chatId: string, sessionId: string): { taskId: string; role: string } | undefined {
    return this.store(chatId).findBySession(sessionId);
  }

  findByTask(taskId: string): Array<{ chatId: string; sessionId: string; role: string }> {
    return [...this.stores.entries()].flatMap(([chatId, store]) =>
      store.findByTask(taskId).map((item) => ({ chatId, ...item })),
    );
  }

  async flush(): Promise<void> {}

  cleanup(linkDays: number, eventDays: number): { links: number; events: number } {
    let links = 0;
    let events = 0;
    for (const store of this.stores.values()) {
      const result = store.cleanup({ linkDays, eventDays });
      links += result.links;
      events += result.events;
    }
    return { links, events };
  }

  close(): void {
    for (const store of this.stores.values()) store.close();
    this.stores.clear();
  }
}
