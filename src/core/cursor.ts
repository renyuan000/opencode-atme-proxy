import { createLogger } from "./logger.js";
import type { Logger } from "./logger.js";
import { readJsonFile, writeJsonAtomic, toErrorMessage } from "./util.js";

interface CursorFile {
  version: 1;
  cursors: Record<string, { lastEndTime: number; updatedAt: number }>;
}

export interface CursorStoreOptions {
  file: string;
  logger?: Logger;
  now?: () => number;
}

export class CursorStore {
  private cursors = new Map<string, { lastEndTime: number; updatedAt: number }>();
  private dirty = false;
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(private readonly options: CursorStoreOptions) {
    this.logger = options.logger ?? createLogger({ scope: "cursor" });
    this.now = options.now ?? Date.now;
  }

  async load(): Promise<void> {
    try {
      const data = await readJsonFile<CursorFile>(this.options.file, {
        version: 1,
        cursors: {},
      });
      for (const [key, value] of Object.entries(data.cursors ?? {})) {
        if (
          value &&
          typeof value.lastEndTime === "number" &&
          typeof value.updatedAt === "number"
        ) {
          this.cursors.set(key, value);
        }
      }
    } catch (error) {
      this.logger.error("failed to load cursors; starting empty", {
        error: toErrorMessage(error),
      });
    }
  }

  get(chatId: string): number | undefined {
    return this.cursors.get(chatId)?.lastEndTime;
  }

  set(chatId: string, lastEndTime: number): void {
    this.cursors.set(chatId, { lastEndTime, updatedAt: this.now() });
    this.dirty = true;
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    await writeJsonAtomic(this.options.file, {
      version: 1,
      cursors: Object.fromEntries(this.cursors),
    } satisfies CursorFile);
    this.dirty = false;
  }
}
