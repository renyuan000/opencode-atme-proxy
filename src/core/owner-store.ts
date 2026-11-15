import { createLogger } from "./logger.js";
import type { Logger } from "./logger.js";
import { readJsonFile, writeJsonAtomic, toErrorMessage } from "./util.js";

export type OwnerBindMethod = "config" | "claim" | "dm";

export interface OwnerBinding {
  platform: string;
  openId: string;
  displayName?: string;
  boundAt: number;
  method: OwnerBindMethod;
}

interface OwnerFile {
  version: 1;
  owners: Record<string, OwnerBinding>;
}

export class OwnerStore {
  private owners = new Map<string, OwnerBinding>();
  private dirty = false;
  private readonly logger: Logger;

  constructor(
    private readonly file: string,
    logger?: Logger,
  ) {
    this.logger = logger ?? createLogger({ scope: "owner" });
  }

  async load(): Promise<void> {
    try {
      const data = await readJsonFile<OwnerFile>(this.file, { version: 1, owners: {} });
      for (const [platform, binding] of Object.entries(data.owners ?? {})) {
        if (binding && typeof binding.openId === "string" && binding.openId) {
          this.owners.set(platform, binding);
        }
      }
    } catch (error) {
      this.logger.error("failed to load owner binding; starting empty", {
        error: toErrorMessage(error),
      });
    }
  }

  get(platform: string): OwnerBinding | undefined {
    return this.owners.get(platform);
  }

  set(binding: OwnerBinding): void {
    this.owners.set(binding.platform, binding);
    this.dirty = true;
  }

  clear(platform: string): boolean {
    const removed = this.owners.delete(platform);
    if (removed) this.dirty = true;
    return removed;
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    await writeJsonAtomic(this.file, {
      version: 1,
      owners: Object.fromEntries(this.owners),
    } satisfies OwnerFile);
    this.dirty = false;
  }
}
