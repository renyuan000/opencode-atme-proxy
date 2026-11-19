import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { TaskRecord } from "./types.js";
import { createLogger } from "./logger.js";
import type { Logger } from "./logger.js";
import { readJsonFile, writeJsonAtomic, toErrorMessage } from "./util.js";

interface TaskIndex {
  version: 1;
  byDedupKey: Record<string, string>;
}

export class TaskStore {
  private index = new Map<string, string>();
  private readonly logger: Logger;
  private indexDirty = false;

  constructor(
    private readonly dir: string,
    logger?: Logger,
  ) {
    this.logger = logger ?? createLogger({ scope: "tasks" });
  }

  private taskPath(taskId: string): string {
    return join(this.dir, "tasks", `${taskId}.json`);
  }

  private indexPath(): string {
    return join(this.dir, "tasks", "index.json");
  }

  async load(): Promise<void> {
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

  async save(task: TaskRecord): Promise<void> {
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
    await this.flush();
  }
}
