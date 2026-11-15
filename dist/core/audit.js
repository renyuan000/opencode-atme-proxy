import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { toErrorMessage } from "./util.js";
export class AuditLog {
    file;
    chain = Promise.resolve();
    constructor(file) {
        this.file = file;
    }
    async append(input) {
        const event = {
            id: randomUUID(),
            ts: Date.now(),
            actor: input.actor,
            action: input.action,
            ...(input.taskId ? { taskId: input.taskId } : {}),
            details: input.details ?? {},
        };
        const line = `${JSON.stringify(event)}\n`;
        this.chain = this.chain.then(async () => {
            await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
            await appendFile(this.file, line, { encoding: "utf8", mode: 0o600 });
        });
        this.chain = this.chain.catch((error) => {
            process.stderr.write(`${JSON.stringify({
                ts: new Date().toISOString(),
                level: "error",
                scope: "audit",
                msg: "failed to append audit event",
                error: toErrorMessage(error),
            })}\n`);
        });
        await this.chain;
        return event;
    }
    auditPath() {
        return this.file;
    }
    static defaultPath(stateDir) {
        return join(stateDir, "audit.jsonl");
    }
}
//# sourceMappingURL=audit.js.map