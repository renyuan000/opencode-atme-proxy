import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "./logger.js";
import { createLogger } from "./logger.js";
import { readJsonFile, writeJsonAtomic } from "./util.js";

export type JobStatus = "queued" | "running" | "waiting_owner" | "done" | "failed" | "dead";
export type JobType = "chat" | "file_analyze" | "scan" | "task_analysis" | "execution";

export interface JobRecord {
  id: string;
  chatId: string;
  messageId: string;
  type: JobType;
  priority: number;
  status: JobStatus;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

export class JobStore {
  private readonly logger: Logger;
  private readonly jobs = new Map<string, JobRecord>();
  private ack: Promise<void> = Promise.resolve();

  constructor(
    private readonly dir: string,
    logger?: Logger,
  ) {
    this.logger = logger ?? createLogger({ scope: "jobs" });
  }

  private taskDir(): string {
    return join(this.dir, "jobs");
  }

  async load(): Promise<void> {
    try {
      await mkdir(this.taskDir(), { recursive: true, mode: 0o700 });
      const files = await readdir(this.taskDir());
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const record = await readJsonFile<JobRecord | undefined>(join(this.taskDir(), file), undefined);
          if (record?.id && record.chatId && record.messageId) {
            this.jobs.set(record.id, record);
          }
        } catch {
          continue;
        }
      }
    } catch (error) {
      this.logger.warn("failed to load jobs", {
        dir: this.dir,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }

  list(status?: JobStatus): JobRecord[] {
    return [...this.jobs.values()].filter((job) => !status || job.status === status);
  }

  async save(record: JobRecord): Promise<void> {
    this.jobs.set(record.id, record);
    await this.flushOne(record);
  }

  async create(input: Omit<JobRecord, "createdAt" | "updatedAt" | "attempts">): Promise<JobRecord> {
    const now = Date.now();
    const existing = this.jobs.get(input.id);
    const record: JobRecord = {
      ...input,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      attempts: existing?.attempts ?? 0,
    };
    await this.save(record);
    return record;
  }

  async update(
    id: string,
    patch: Partial<Pick<JobRecord, "status" | "priority" | "error" | "attempts">>,
  ): Promise<JobRecord | undefined> {
    const record = this.jobs.get(id);
    if (!record) return undefined;
    Object.assign(record, patch, { updatedAt: Date.now() });
    await this.flushOne(record);
    return record;
  }

  private async flushOne(record: JobRecord): Promise<void> {
    this.ack = this.ack
      .catch(() => {})
      .then(async () => {
        await mkdir(this.taskDir(), { recursive: true, mode: 0o700 });
        await writeJsonAtomic(join(this.taskDir(), `${record.id}.json`), record);
      })
      .catch((error) => {
        this.logger.warn("failed to persist job", {
          jobId: record.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    await this.ack;
  }

  async flush(): Promise<void> {
    await this.ack;
  }
}
