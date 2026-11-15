import { createLogger } from "./logger.js";
import type { Logger } from "./logger.js";
import { readJsonFile, writeJsonAtomic, toErrorMessage } from "./util.js";

interface SessionFile {
  version: 1;
  sessions: Record<string, { sessionId: string; updatedAt: number }>;
}

export class SessionStore {
  private sessions = new Map<string, { sessionId: string; updatedAt: number }>();
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
          this.sessions.set(key, value);
        }
      }
    } catch (error) {
      this.logger.error("failed to load sessions; starting empty", {
        error: toErrorMessage(error),
      });
    }
  }

  get(key: string): string | undefined {
    return this.sessions.get(key)?.sessionId;
  }

  set(key: string, sessionId: string): void {
    this.sessions.set(key, { sessionId, updatedAt: Date.now() });
    this.dirty = true;
  }

  delete(key: string): void {
    if (this.sessions.delete(key)) this.dirty = true;
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
