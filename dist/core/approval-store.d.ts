import type { ApprovalKind, ApprovalRecord } from "./types.js";
export declare class ApprovalStore {
    private readonly dir;
    constructor(dir: string);
    private path;
    list(taskId: string): Promise<ApprovalRecord[]>;
    latest(taskId: string, kind: ApprovalKind): Promise<ApprovalRecord | undefined>;
    append(record: ApprovalRecord): Promise<void>;
    replaceLatest(record: ApprovalRecord): Promise<void>;
}
