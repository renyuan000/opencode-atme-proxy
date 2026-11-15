import type { ActorRef, AuditEvent } from "./types.js";
export declare class AuditLog {
    private readonly file;
    private chain;
    constructor(file: string);
    append(input: {
        actor: ActorRef | {
            system: true;
        };
        action: string;
        taskId?: string;
        details?: Record<string, unknown>;
    }): Promise<AuditEvent>;
    auditPath(): string;
    static defaultPath(stateDir: string): string;
}
