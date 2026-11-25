import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TaskRecord } from "./types.js";
import { createLogger } from "./logger.js";
import type { Logger } from "./logger.js";
import { readJsonFile, writeJsonAtomic, toErrorMessage } from "./util.js";
import type { TaskStateDb } from "./task-state-db.js";

interface TaskIndex {
  version: 1;
  byDedupKey: Record<string, string>;
}

export class TaskStore {
  private index = new Map<string, string>();
  private readonly logger: Logger;
  private indexDirty = false;

  private readonly db?: Database.Database;
  private readonly state?: TaskStateDb;

  constructor(
    private readonly dir: string,
    logger?: Logger,
    dbPath?: string,
    state?: TaskStateDb,
  ) {
    this.logger = logger ?? createLogger({ scope: "tasks" });
    this.state = state;
    if (dbPath) {
      mkdirSync(dirname(dbPath), { recursive: true });
      this.db = new Database(dbPath);
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          task_id TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS task_index (
          dedup_key TEXT PRIMARY KEY,
          task_id TEXT NOT NULL
        );
      `);
    }
  }

  private taskPath(taskId: string): string {
    return join(this.dir, "tasks", `${taskId}.json`);
  }

  private indexPath(): string {
    return join(this.dir, "tasks", "index.json");
  }

  async load(): Promise<void> {
    if (this.state) {
      if (this.state.taskCount() === 0) await this.migrateLegacyToState();
      for (const row of this.state.taskIndex()) this.index.set(row.dedupKey, row.taskId);
      return;
    }
    if (this.db) {
      const rows = this.db.prepare("SELECT task_id, data FROM tasks").all() as Array<{ task_id: string; data: string }>;
      if (rows.length === 0) await this.migrateLegacyToDb();
      for (const row of this.db.prepare("SELECT dedup_key, task_id FROM task_index").all() as Array<{ dedup_key: string; task_id: string }>) {
        this.index.set(row.dedup_key, row.task_id);
      }
      return;
    }
    try {
      const data = await readJsonFile<TaskIndex>(this.indexPath(), {
        version: 1,
        byDedupKey: {},
      });
      for (const [key, taskId] of Object.entries(data.byDedupKey ?? {})) {
        if (typeof taskId === "string") this.index.set(key, taskId);
      }
    } catch (error) {
      this.logger.error("failed to load task index; starting empty", {
        error: toErrorMessage(error),
      });
    }
  }

  async get(taskId: string): Promise<TaskRecord | undefined> {
    if (this.state) {
      const data = this.state.getTask(taskId);
      if (!data) return undefined;
      try {
        return JSON.parse(data) as TaskRecord;
      } catch {
        return undefined;
      }
    }
    if (this.db) {
      const row = this.db.prepare("SELECT data FROM tasks WHERE task_id = ?").get(taskId) as { data?: string } | undefined;
      if (!row?.data) return undefined;
      try {
        return JSON.parse(row.data) as TaskRecord;
      } catch {
        return undefined;
      }
    }
    try {
      return await readJsonFile<TaskRecord | undefined>(this.taskPath(taskId), undefined);
    } catch (error) {
      this.logger.error("failed to read task", { taskId, error: toErrorMessage(error) });
      return undefined;
    }
  }

  findByDedupKey(dedupKey: string): string | undefined {
    return this.index.get(dedupKey);
  }

  async findByMessageId(messageId: string): Promise<TaskRecord | undefined> {
    const tasks = await this.list();
    return tasks.find(
      (task) => task.id === messageId || task.messageIds?.includes(messageId),
    );
  }

  async list(): Promise<TaskRecord[]> {
    if (this.state) {
      return this.state.listTaskData()
        .map((data) => {
          try {
            return JSON.parse(data) as TaskRecord;
          } catch {
            return undefined;
          }
        })
        .filter((task): task is TaskRecord => Boolean(task));
    }
    if (this.db) {
      return (this.db.prepare("SELECT data FROM tasks").all() as Array<{ data: string }>)
        .map((row) => {
          try {
            return JSON.parse(row.data) as TaskRecord;
          } catch {
            return undefined;
          }
        })
        .filter((task): task is TaskRecord => Boolean(task));
    }
    try {
      const files = await readdir(join(this.dir, "tasks"));
      const tasks: TaskRecord[] = [];
      for (const file of files) {
        if (!file.endsWith(".json") || file === "index.json") continue;
        const task = await readJsonFile<TaskRecord | undefined>(
          join(this.dir, "tasks", file),
          undefined,
        );
        if (task && typeof task.id === "string") tasks.push(task);
      }
      return tasks;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: string }).code === "ENOENT"
      ) {
        return [];
      }
      this.logger.error("failed to list tasks", { error: toErrorMessage(error) });
      return [];
    }
  }

  async redactMessage(messageId: string): Promise<void> {
    const tasks = await this.list();
    for (const task of tasks) {
      if (!task.supplements?.some((item) => item.messageId === messageId)) continue;
      task.supplements = task.supplements.map((item) =>
        item.messageId === messageId ? { ...item, text: "[已撤回]" } : item,
      );
      task.updatedAt = Date.now();
      await this.save(task);
    }
  }

  async saveWithLinks(task: TaskRecord, messageIds: string[]): Promise<boolean> {
    if (!this.state) return false;
    this.state.saveTaskWithLinks(task.id, JSON.stringify(task), task.updatedAt, task.dedupKey, messageIds);
    this.index.set(task.dedupKey, task.id);
    return true;
  }

  async save(task: TaskRecord): Promise<void> {
    if (this.state) {
      this.state.saveTask(task.id, JSON.stringify(task), task.updatedAt, task.dedupKey);
      this.index.set(task.dedupKey, task.id);
      return;
    }
    if (this.db) {
      const transaction = this.db.transaction(() => {
        this.db!.prepare("INSERT INTO tasks(task_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at")
          .run(task.id, JSON.stringify(task), task.updatedAt);
        this.db!.prepare("INSERT INTO task_index(dedup_key, task_id) VALUES (?, ?) ON CONFLICT(dedup_key) DO UPDATE SET task_id = excluded.task_id")
          .run(task.dedupKey, task.id);
      });
      transaction();
      this.index.set(task.dedupKey, task.id);
      return;
    }
    await writeJsonAtomic(this.taskPath(task.id), task);
    if (this.index.get(task.dedupKey) !== task.id) {
      this.index.set(task.dedupKey, task.id);
      this.indexDirty = true;
    }
  }

  async flush(): Promise<void> {
    if (!this.indexDirty) return;
    await writeJsonAtomic(this.indexPath(), {
      version: 1,
      byDedupKey: Object.fromEntries(this.index),
    } satisfies TaskIndex);
    this.indexDirty = false;
  }

  async close(): Promise<void> {
    if (this.state) return;
    if (this.db) {
      this.db.close();
      return;
    }
    await this.flush();
  }

  private async migrateLegacyToState(): Promise<void> {
    if (!this.state) return;
    let files: string[] = [];
    try {
      files = await readdir(join(this.dir, "tasks"));
    } catch {
      return;
    }
    for (const file of files) {
      if (!file.endsWith(".json") || file === "index.json") continue;
      try {
        const task = await readJsonFile<TaskRecord | undefined>(join(this.dir, "tasks", file), undefined);
        if (!task || typeof task.id !== "string") continue;
        this.state.saveTask(task.id, JSON.stringify(task), task.updatedAt ?? Date.now(), task.dedupKey);
      } catch (error) {
        this.logger.warn("legacy task migration skipped", { file, error: toErrorMessage(error) });
      }
    }
    this.state.markLegacyTasksImported();
  }

  private async migrateLegacyToDb(): Promise<void> {
    if (!this.db) return;
    let files: string[] = [];
    try {
      files = await readdir(join(this.dir, "tasks"));
    } catch {
      return;
    }
    for (const file of files) {
      if (!file.endsWith(".json") || file === "index.json") continue;
      try {
        const task = await readJsonFile<TaskRecord | undefined>(join(this.dir, "tasks", file), undefined);
        if (!task || typeof task.id !== "string") continue;
        this.db.prepare("INSERT OR IGNORE INTO tasks(task_id, data, updated_at) VALUES (?, ?, ?)")
          .run(task.id, JSON.stringify(task), task.updatedAt ?? Date.now());
        this.db.prepare("INSERT OR IGNORE INTO task_index(dedup_key, task_id) VALUES (?, ?)")
          .run(task.dedupKey, task.id);
      } catch (error) {
        this.logger.warn("legacy task migration skipped", { file, error: toErrorMessage(error) });
      }
    }
  }
}
