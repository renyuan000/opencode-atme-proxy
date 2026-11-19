import { createLogger } from "./logger.js";
import type { Logger } from "./logger.js";
import { readJsonFile, writeJsonAtomic } from "./util.js";
import type { GroupStateLayout } from "./group-state.js";

export interface DocumentReference {
  url: string;
  title?: string;
  messageId?: string;
  senderId?: string;
  seenAt: number;
  lastFetchedAt?: number;
  status: "indexed" | "fetched" | "failed" | "skipped";
  cached: boolean;
}

interface DocumentRefFile {
  version: 1;
  entries: Record<string, DocumentReference>;
}

export class ScopedDocumentRefs {
  private readonly logger: Logger;
  private readonly maps = new Map<string, Map<string, DocumentReference>>();
  private readonly dirty = new Set<string>();

  constructor(
    private readonly layout: GroupStateLayout,
    logger?: Logger,
    private readonly ttlMs = 90 * 24 * 3600_000,
  ) {
    this.logger = logger ?? createLogger({ scope: "document-refs" });
  }

  private file(chatId: string): string {
    return `${this.layout.dirFor(chatId)}/document-refs.json`;
  }

  private map(chatId: string): Map<string, DocumentReference> {
    const existing = this.maps.get(chatId);
    if (existing) return existing;
    const map = new Map<string, DocumentReference>();
    this.maps.set(chatId, map);
    return map;
  }

  async load(): Promise<void> {
    for (const info of this.layout.all()) {
      try {
        const data = await readJsonFile<DocumentRefFile>(this.file(info.chatId), {
          version: 1,
          entries: {},
        });
        const cutoff = Date.now() - this.ttlMs;
        const map = new Map<string, DocumentReference>();
        for (const [url, ref] of Object.entries(data.entries ?? {})) {
          if (ref && ref.seenAt >= cutoff) map.set(url, ref);
        }
        this.maps.set(info.chatId, map);
      } catch (error) {
        this.logger.warn("failed to load document refs", {
          chatId: info.chatId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  record(
    chatId: string,
    input: {
      url: string;
      title?: string;
      messageId?: string;
      senderId?: string;
      status?: DocumentReference["status"];
      cached?: boolean;
    },
  ): void {
    const map = this.map(chatId);
    const previous = map.get(input.url);
    map.set(input.url, {
      ...(previous ?? {}),
      url: input.url,
      ...(input.title ?? previous?.title ? { title: input.title ?? previous?.title } : {}),
      ...(input.messageId ?? previous?.messageId
        ? { messageId: input.messageId ?? previous?.messageId }
        : {}),
      ...(input.senderId ?? previous?.senderId
        ? { senderId: input.senderId ?? previous?.senderId }
        : {}),
      seenAt: Date.now(),
      status: input.status ?? previous?.status ?? "indexed",
      ...(input.status === "fetched" ? { lastFetchedAt: Date.now() } : {}),
      cached: input.cached ?? previous?.cached ?? false,
    });
    while (map.size > 200) {
      const oldest = [...map.entries()].sort((a, b) => a[1].seenAt - b[1].seenAt)[0];
      if (!oldest) break;
      map.delete(oldest[0]);
    }
    this.dirty.add(chatId);
  }

  list(chatId: string, limit = 20): DocumentReference[] {
    return [...this.map(chatId).values()]
      .sort((a, b) => b.seenAt - a.seenAt)
      .slice(0, limit);
  }

  get(chatId: string, url: string): DocumentReference | undefined {
    return this.map(chatId).get(url);
  }

  async flush(): Promise<void> {
    for (const chatId of this.dirty) {
      await writeJsonAtomic(this.file(chatId), {
        version: 1,
        entries: Object.fromEntries(this.map(chatId)),
      } satisfies DocumentRefFile);
    }
    this.dirty.clear();
  }
}
