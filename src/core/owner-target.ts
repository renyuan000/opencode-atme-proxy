import { createLogger } from "./logger.js";
import type { Logger } from "./logger.js";
import { readJsonFile, writeJsonAtomic } from "./util.js";

export interface OwnerTarget {
  ownerId: string;
  chatId: string;
  chatName?: string;
  sourceMessageId?: string;
  taskId?: string;
  updatedAt: number;
}

interface OwnerTargetFile {
  version: 1;
  targets: Record<string, OwnerTarget>;
}

export class OwnerTargetStore {
  private targets = new Map<string, OwnerTarget>();
  private dirty = false;
  private readonly logger: Logger;

  constructor(
    private readonly file: string,
    logger?: Logger,
  ) {
    this.logger = logger ?? createLogger({ scope: "owner-target" });
  }

  async load(): Promise<void> {
    const data = await readJsonFile<OwnerTargetFile>(this.file, { version: 1, targets: {} });
    for (const [ownerId, target] of Object.entries(data.targets ?? {})) {
      if (target && typeof target.chatId === "string" && typeof target.updatedAt === "number") {
        this.targets.set(ownerId, { ...target, ownerId });
      }
    }
  }

  get(ownerId: string, maxAgeMs = 4 * 3600_000): OwnerTarget | undefined {
    const target = this.targets.get(ownerId);
    if (!target) return undefined;
    if (Date.now() - target.updatedAt > maxAgeMs) {
      this.targets.delete(ownerId);
      this.dirty = true;
      return undefined;
    }
    return target;
  }

  set(target: OwnerTarget): void {
    this.targets.set(target.ownerId, target);
    this.dirty = true;
  }

  clear(ownerId: string): void {
    if (this.targets.delete(ownerId)) this.dirty = true;
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    await writeJsonAtomic(this.file, {
      version: 1,
      targets: Object.fromEntries(this.targets),
    } satisfies OwnerTargetFile);
    this.dirty = false;
  }
}
