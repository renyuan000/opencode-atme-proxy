import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ActorRef, AuditEvent } from "./types.js";
import { toErrorMessage } from "./util.js";

export class AuditLog {
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async append(input: {
    actor: ActorRef | { system: true };
    action: string;
    taskId?: string;
    details?: Record<string, unknown>;
  }): Promise<AuditEvent> {
    const event: AuditEvent = {
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
      process.stderr.write(
        `${JSON.stringify({
          ts: new Date().toISOString(),
          level: "error",
          scope: "audit",
          msg: "failed to append audit event",
          error: toErrorMessage(error),
        })}\n`,
      );
    });
    await this.chain;
    return event;
  }

  auditPath(): string {
    return this.file;
  }

  static defaultPath(stateDir: string): string {
    return join(stateDir, "audit.jsonl");
  }
}
