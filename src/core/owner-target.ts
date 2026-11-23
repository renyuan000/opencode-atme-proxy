import { createLogger } from "./logger.js";
import type { Logger } from "./logger.js";
import { readJsonFile, writeJsonAtomic } from "./util.js";

export interface OwnerTarget {
  ownerId: string;
  chatId: string;
  conversationId?: string;
  chatName?: string;
  sourceMessageId?: string;
  taskId?: string;
  updatedAt: number;
}

interface OwnerTargetFile {
  version: 1;
  targets: Record<string, OwnerTarget | OwnerTarget[]>;
}

export class OwnerTargetStore {
  private targets = new Map<string, OwnerTarget[]>();
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
    for (const [ownerId, value] of Object.entries(data.targets ?? {})) {
      const list = Array.isArray(value) ? value : [value];
      const valid = list
        .filter((target) => target && typeof target.chatId === "string")
        .map((target) => ({ ...target, ownerId }));
      if (valid.length > 0) this.targets.set(ownerId, valid.slice(0, 5));
    }
  }

  list(ownerId: string, maxAgeMs = 4 * 3600_000): OwnerTarget[] {
    const now = Date.now();
    const list = (this.targets.get(ownerId) ?? []).filter(
      (target) => now - target.updatedAt <= maxAgeMs,
    );
    if (list.length !== (this.targets.get(ownerId)?.length ?? 0)) {
      this.targets.set(ownerId, list);
      this.dirty = true;
    }
    return list;
  }

  get(ownerId: string, maxAgeMs = 4 * 3600_000): OwnerTarget | undefined {
    return this.list(ownerId, maxAgeMs)[0];
  }

  set(target: OwnerTarget): void {
    const current = this.targets.get(target.ownerId) ?? [];
    const next = [
      target,
      ...current.filter(
        (item) =>
          item.chatId !== target.chatId ||
          (item.sourceMessageId ?? "") !== (target.sourceMessageId ?? ""),
      ),
    ].slice(0, 5);
    this.targets.set(target.ownerId, next);
    this.dirty = true;
  }

  select(ownerId: string, value: string): OwnerTarget | undefined {
    const list = this.list(ownerId);
    const index = Number(value);
    const selected = Number.isInteger(index) && index > 0
      ? list[index - 1]
      : list.find(
          (target) =>
            target.chatId === value ||
            target.sourceMessageId === value ||
            target.chatName === value,
        );
    if (!selected) return undefined;
    this.targets.set(ownerId, [selected, ...list.filter((item) => item !== selected)]);
    this.dirty = true;
    return selected;
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
