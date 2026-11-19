import { createLogger } from "./logger.js";
import type { Logger } from "./logger.js";
import { readJsonFile, writeJsonAtomic } from "./util.js";
import type { GroupStateLayout } from "./group-state.js";

export interface DocumentCacheEntry {
  url: string;
  title?: string;
  text: string;
  fetchedAt: number;
  lastUsedAt: number;
  hits: number;
}

interface DocumentCacheFile {
  version: 1;
  entries: Record<string, DocumentCacheEntry>;
}

export class ScopedDocumentCache {
  private readonly logger: Logger;
  private readonly maps = new Map<string, Map<string, DocumentCacheEntry>>();
  private readonly dirty = new Set<string>();

  constructor(
    private readonly layout: GroupStateLayout,
    logger?: Logger,
    private readonly ttlMs = 7 * 24 * 3600_000,
  ) {
    this.logger = logger ?? createLogger({ scope: "document-cache" });
  }

  private file(chatId: string): string {
    return `${this.layout.dirFor(chatId)}/document-cache.json`;
  }

  private map(chatId: string): Map<string, DocumentCacheEntry> {
    const existing = this.maps.get(chatId);
    if (existing) return existing;
    const created = new Map<string, DocumentCacheEntry>();
    this.maps.set(chatId, created);
    return created;
  }

  async load(): Promise<void> {
    for (const info of this.layout.all()) {
      try {
        const data = await readJsonFile<DocumentCacheFile>(this.file(info.chatId), {
          version: 1,
          entries: {},
        });
        const map = new Map<string, DocumentCacheEntry>();
        const cutoff = Date.now() - this.ttlMs;
        for (const [url, entry] of Object.entries(data.entries ?? {})) {
          if (entry && entry.text && entry.lastUsedAt >= cutoff) map.set(url, entry);
        }
        this.maps.set(info.chatId, map);
      } catch (error) {
        this.logger.warn("failed to load document cache", {
          chatId: info.chatId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  get(chatId: string, url: string): DocumentCacheEntry | undefined {
    const entry = this.map(chatId).get(url);
    if (!entry) return undefined;
    if (Date.now() - entry.lastUsedAt > this.ttlMs) {
      this.map(chatId).delete(url);
      this.dirty.add(chatId);
      return undefined;
    }
    entry.lastUsedAt = Date.now();
    entry.hits += 1;
    this.dirty.add(chatId);
    return entry;
  }

  set(chatId: string, entry: Omit<DocumentCacheEntry, "fetchedAt" | "lastUsedAt" | "hits">): void {
    const map = this.map(chatId);
    const now = Date.now();
    map.set(entry.url, { ...entry, fetchedAt: now, lastUsedAt: now, hits: 0 });
    while (map.size > 50) {
      const oldest = [...map.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
      if (!oldest) break;
      map.delete(oldest[0]);
    }
    this.dirty.add(chatId);
  }

  async flush(): Promise<void> {
    for (const chatId of this.dirty) {
      await writeJsonAtomic(this.file(chatId), {
        version: 1,
        entries: Object.fromEntries(this.map(chatId)),
      } satisfies DocumentCacheFile);
    }
    this.dirty.clear();
  }
}
