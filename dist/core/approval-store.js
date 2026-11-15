import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "./util.js";
export class ApprovalStore {
    dir;
    constructor(dir) {
        this.dir = dir;
    }
    path(taskId) {
        return join(this.dir, "approvals", `${taskId}.json`);
    }
    async list(taskId) {
        const data = await readJsonFile(this.path(taskId), {
            version: 1,
            records: [],
        });
        return data.records ?? [];
    }
    async latest(taskId, kind) {
        const records = await this.list(taskId);
        for (let index = records.length - 1; index >= 0; index--) {
            const record = records[index];
            if (record && record.kind === kind)
                return record;
        }
        return undefined;
    }
    async append(record) {
        const records = await this.list(record.taskId);
        records.push(record);
        await writeJsonAtomic(this.path(record.taskId), {
            version: 1,
            records,
        });
    }
    async replaceLatest(record) {
        const records = await this.list(record.taskId);
        for (let index = records.length - 1; index >= 0; index--) {
            const existing = records[index];
            if (existing && existing.kind === record.kind) {
                records[index] = record;
                await writeJsonAtomic(this.path(record.taskId), {
                    version: 1,
                    records,
                });
                return;
            }
        }
        records.push(record);
        await writeJsonAtomic(this.path(record.taskId), {
            version: 1,
            records,
        });
    }
}
//# sourceMappingURL=approval-store.js.map