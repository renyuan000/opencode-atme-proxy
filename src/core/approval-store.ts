import { join } from "node:path";
import type { ApprovalKind, ApprovalRecord } from "./types.js";
import { readJsonFile, writeJsonAtomic } from "./util.js";

interface ApprovalFile {
  version: 1;
  records: ApprovalRecord[];
}

export class ApprovalStore {
  constructor(private readonly dir: string) {}

  private path(taskId: string): string {
    return join(this.dir, "approvals", `${taskId}.json`);
  }

  async list(taskId: string): Promise<ApprovalRecord[]> {
    const data = await readJsonFile<ApprovalFile>(this.path(taskId), {
      version: 1,
      records: [],
    });
    return data.records ?? [];
  }

  async latest(taskId: string, kind: ApprovalKind): Promise<ApprovalRecord | undefined> {
    const records = await this.list(taskId);
    for (let index = records.length - 1; index >= 0; index--) {
      const record = records[index];
      if (record && record.kind === kind) return record;
    }
    return undefined;
  }

  async append(record: ApprovalRecord): Promise<void> {
    const records = await this.list(record.taskId);
    records.push(record);
    await writeJsonAtomic(this.path(record.taskId), {
      version: 1,
      records,
    } satisfies ApprovalFile);
  }

  async replaceLatest(record: ApprovalRecord): Promise<void> {
    const records = await this.list(record.taskId);
    for (let index = records.length - 1; index >= 0; index--) {
      const existing = records[index];
      if (existing && existing.kind === record.kind) {
        records[index] = record;
        await writeJsonAtomic(this.path(record.taskId), {
          version: 1,
          records,
        } satisfies ApprovalFile);
        return;
      }
    }
    records.push(record);
    await writeJsonAtomic(this.path(record.taskId), {
      version: 1,
      records,
    } satisfies ApprovalFile);
  }
}
