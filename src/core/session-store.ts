import { createLogger } from "./logger.js";
import type { Logger } from "./logger.js";
import { readJsonFile, writeJsonAtomic, toErrorMessage } from "./util.js";

export type SessionKind = "coordinator" | "group" | "worker" | "child";

export interface SessionRecord {
  sessionId: string;
  directory: string;
  updatedAt: number;
  createdAt: number;
  kind: SessionKind;
  taskId?: string;
  chatId?: string;
  conversationId?: string;
  archivedAt?: number;
}

interface SessionFile {
  version: 1;
  sessions: Record<string, SessionRecord>;
}

export class SessionStore {
  private sessions = new Map<string, SessionRecord>();
  private dirty = false;
  private readonly logger: Logger;

  constructor(
    private readonly file: string,
    logger?: Logger,
  ) {
    this.logger = logger ?? createLogger({ scope: "sessions" });
  }

  async load(): Promise<void> {
    try {
      const data = await readJsonFile<SessionFile>(this.file, { version: 1, sessions: {} });
      for (const [key, value] of Object.entries(data.sessions ?? {})) {
        if (value && typeof value.sessionId === "string") {
          this.sessions.set(key, {
            sessionId: value.sessionId,
            directory: typeof value.directory === "string" ? value.directory : "",
            updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
            createdAt:
              typeof value.createdAt === "number"
                ? value.createdAt
                : typeof value.updatedAt === "number"
                  ? value.updatedAt
                  : 0,
            kind:
              value.kind === "coordinator" ||
              value.kind === "group" ||
              value.kind === "worker" ||
              value.kind === "child"
                ? value.kind
                : "coordinator",
            ...(typeof value.taskId === "string" ? { taskId: value.taskId } : {}),
            ...(typeof value.chatId === "string" ? { chatId: value.chatId } : {}),
            ...(typeof value.conversationId === "string"
              ? { conversationId: value.conversationId }
              : {}),
            ...(typeof value.archivedAt === "number" ? { archivedAt: value.archivedAt } : {}),
          });
        }
      }
    } catch (error) {
      this.logger.error("failed to load sessions; starting empty", {
        error: toErrorMessage(error),
      });
    }
  }

  get(key: string): SessionRecord | undefined {
    return this.sessions.get(key);
  }

  set(
    key: string,
    sessionId: string,
    directory: string,
    meta?: { kind?: SessionKind; taskId?: string; chatId?: string; conversationId?: string; createdAt?: number; archivedAt?: number },
  ): void {
    const now = Date.now();
    const existing = this.sessions.get(key);
    this.sessions.set(key, {
      sessionId,
      directory,
      updatedAt: now,
      createdAt: meta?.createdAt ?? existing?.createdAt ?? now,
      kind: meta?.kind ?? existing?.kind ?? "coordinator",
      ...(meta?.taskId ?? existing?.taskId ? { taskId: meta?.taskId ?? existing?.taskId } : {}),
      ...(meta?.chatId ?? existing?.chatId ? { chatId: meta?.chatId ?? existing?.chatId } : {}),
      ...(meta?.conversationId ?? existing?.conversationId
        ? { conversationId: meta?.conversationId ?? existing?.conversationId }
        : {}),
      ...(meta?.archivedAt ?? existing?.archivedAt
        ? { archivedAt: meta?.archivedAt ?? existing?.archivedAt }
        : {}),
    });
    this.dirty = true;
  }

  list(kind?: SessionKind): Array<[string, SessionRecord]> {
    const entries = [...this.sessions.entries()];
    return kind ? entries.filter(([, record]) => record.kind === kind) : entries;
  }

  delete(key: string): void {
    if (this.sessions.delete(key)) this.dirty = true;
  }

  findByTask(taskId: string, kind: SessionKind = "child"): Array<[string, SessionRecord]> {
    return [...this.sessions.entries()].filter(
      ([, record]) => record.kind === kind && record.taskId === taskId,
    );
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    await writeJsonAtomic(this.file, {
      version: 1,
      sessions: Object.fromEntries(this.sessions),
    } satisfies SessionFile);
    this.dirty = false;
  }
}
