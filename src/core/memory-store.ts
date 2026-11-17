import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "./logger.js";
import type { Logger } from "./logger.js";
import { readJsonFile, writeJsonAtomic, sha256, toErrorMessage, truncate } from "./util.js";

export type MemoryKind = "task" | "decision" | "fact" | "preference" | "deadline" | "outcome";

export interface MemoryRecord {
  id: string;
  platform: string;
  chatId?: string;
  projectId?: string;
  kind: MemoryKind;
  key: string;
  value: string;
  sourceMessageIds: string[];
  tags: string[];
  confidence: number;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
}

interface MemoryFile {
  version: 1;
  entries: Record<string, MemoryRecord>;
}

interface HistoryEntry {
  ts: number;
  action: "create" | "update" | "delete";
  before?: MemoryRecord;
  after?: MemoryRecord;
}

export interface MemoryStoreOptions {
  file: string;
  shardDir?: string;
  requireSource?: boolean;
  maxEntries: number;
  ttlMs: number;
  pinnedKinds: MemoryKind[];
  logger?: Logger;
  now?: () => number;
}

export interface MemoryInput {
  platform: string;
  kind: MemoryKind;
  key: string;
  value: string;
  chatId?: string;
  projectId?: string;
  sourceMessageIds?: string[];
  tags?: string[];
  confidence?: number;
  pinned?: boolean;
  ttlMs?: number;
}

export interface MemoryQuery {
  platform: string;
  chatId?: string;
  projectId?: string;
  text?: string;
  limit: number;
}

export class MemoryStore {
  private entries = new Map<string, MemoryRecord>();
  private dirty = false;
  private readonly dirtyShards = new Set<string>();
  private readonly history = new Map<string, HistoryEntry[]>();
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly pinnedKinds: Set<MemoryKind>;
  private readonly shardDir?: string;
  private readonly requireSource: boolean;

  constructor(private readonly options: MemoryStoreOptions) {
    this.logger = options.logger ?? createLogger({ scope: "memory" });
    this.now = options.now ?? Date.now;
    this.pinnedKinds = new Set(options.pinnedKinds);
    this.shardDir = options.shardDir;
    this.requireSource = options.requireSource !== false;
  }

  async load(): Promise<void> {
    try {
      const data = await readJsonFile<MemoryFile>(this.options.file, { version: 1, entries: {} });
      const now = this.now();
      for (const [id, entry] of Object.entries(data.entries ?? {})) {
        if (!entry || typeof entry.value !== "string") continue;
        if (!entry.pinned && entry.expiresAt !== undefined && entry.expiresAt <= now) continue;
        this.entries.set(id, entry);
      }
      this.prune();
    } catch (error) {
      this.logger.error("failed to load memory; starting empty", {
        error: toErrorMessage(error),
      });
    }
  }

  upsert(input: MemoryInput): MemoryRecord {
    const id = sha256(`${input.platform}:${input.chatId ?? ""}:${input.kind}:${input.key}`).slice(0, 20);
    const now = this.now();
    const existing = this.entries.get(id);
    if (
      this.requireSource &&
      (input.sourceMessageIds?.length ?? 0) === 0 &&
      (existing?.sourceMessageIds.length ?? 0) === 0
    ) {
      throw new Error(`memory ${input.kind}:${input.key} requires sourceMessageIds`);
    }
    const pinned = Boolean(input.pinned || this.pinnedKinds.has(input.kind));
    const expiresAt =
      pinned
        ? undefined
        : input.ttlMs !== undefined
          ? now + input.ttlMs
          : existing?.expiresAt ?? now + this.options.ttlMs;
    const record: MemoryRecord = {
      id,
      platform: input.platform,
      ...(input.chatId ? { chatId: input.chatId } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      kind: input.kind,
      key: input.key,
      value: truncate(input.value, 1000),
      sourceMessageIds: unique([
        ...(existing?.sourceMessageIds ?? []),
        ...(input.sourceMessageIds ?? []),
      ]).slice(-20),
      tags: unique([...(existing?.tags ?? []), ...(input.tags ?? [])]).slice(-20),
      confidence: input.confidence ?? existing?.confidence ?? 0.8,
      pinned: pinned || Boolean(existing?.pinned),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
    this.entries.set(id, record);
    this.dirty = true;
    const chatKey = record.chatId ?? "_global";
    this.dirtyShards.add(chatKey);
    const changes = this.history.get(chatKey) ?? [];
    changes.push({
      ts: now,
      action: existing ? "update" : "create",
      ...(existing ? { before: existing } : {}),
      after: record,
    });
    this.history.set(chatKey, changes);
    if (this.entries.size > this.options.maxEntries) this.prune();
    return record;
  }

  get(id: string): MemoryRecord | undefined {
    return this.entries.get(id);
  }

  delete(id: string): boolean {
    const record = this.entries.get(id);
    const removed = this.entries.delete(id);
    if (removed && record) {
      this.dirty = true;
      const chatKey = record.chatId ?? "_global";
      this.dirtyShards.add(chatKey);
      const changes = this.history.get(chatKey) ?? [];
      changes.push({ ts: this.now(), action: "delete", before: record });
      this.history.set(chatKey, changes);
    }
    return removed;
  }

  query(input: MemoryQuery): MemoryRecord[] {
    const now = this.now();
    const terms = tokenize(input.text ?? "");
    const scored: Array<{ record: MemoryRecord; score: number }> = [];
    for (const record of this.entries.values()) {
      if (record.platform !== input.platform) continue;
      if (!record.pinned && record.expiresAt !== undefined && record.expiresAt <= now) continue;
      if (input.chatId && record.chatId !== input.chatId) continue;
      if (record.projectId && input.projectId && record.projectId !== input.projectId) continue;
      let score = record.pinned ? 100 : 0;
      if (record.chatId && record.chatId === input.chatId) score += 20;
      if (record.projectId && record.projectId === input.projectId) score += 15;
      score += recencyScore(record.updatedAt, now, 30);
      if (terms.length > 0) {
        const haystack = `${record.key}\n${record.value}\n${record.tags.join(" ")}`.toLowerCase();
        for (const term of terms) {
          if (haystack.includes(term)) score += 10;
        }
        if (score < 10 && !record.pinned && record.kind !== "decision") continue;
      }
      scored.push({ record, score });
    }
    scored.sort((a, b) => b.score - a.score || b.record.updatedAt - a.record.updatedAt);
    return scored.slice(0, input.limit).map((item) => item.record);
  }

  prune(): void {
    const now = this.now();
    for (const [id, record] of this.entries) {
      if (!record.pinned && record.expiresAt !== undefined && record.expiresAt <= now) {
        this.entries.delete(id);
        this.dirty = true;
        this.dirtyShards.add(record.chatId ?? "_global");
      }
    }
    if (this.entries.size <= this.options.maxEntries) return;
    const sorted = [...this.entries.values()].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return a.updatedAt - b.updatedAt;
    });
    const excess = this.entries.size - this.options.maxEntries;
    for (let index = 0; index < excess; index++) {
      const record = sorted[index];
      if (!record) break;
      if (record.pinned) break;
      this.entries.delete(record.id);
      this.dirty = true;
      this.dirtyShards.add(record.chatId ?? "_global");
    }
  }

  size(): number {
    return this.entries.size;
  }

  async flush(): Promise<void> {
    if (!this.dirty && this.dirtyShards.size === 0) return;
    this.prune();
    await writeJsonAtomic(this.options.file, {
      version: 1,
      entries: Object.fromEntries(this.entries),
    } satisfies MemoryFile);
    if (this.shardDir) await this.writeShards();
    this.dirty = false;
    this.dirtyShards.clear();
    this.history.clear();
  }

  async migrateShards(): Promise<void> {
    if (!this.shardDir) return;
    for (const record of this.entries.values()) {
      this.dirtyShards.add(record.chatId ?? "_global");
    }
    await this.flush();
  }

  private async writeShards(): Promise<void> {
    if (!this.shardDir) return;
    const now = this.now();
    for (const chatKey of this.dirtyShards) {
      const dir = join(this.shardDir, sanitizeFolder(chatKey));
      const records = [...this.entries.values()].filter(
        (record) => (record.chatId ?? "_global") === chatKey,
      );
      await writeJsonAtomic(join(dir, "records.json"), {
        version: 1,
        chatId: chatKey,
        updatedAt: now,
        records: Object.fromEntries(records.map((record) => [record.id, record])),
      });
      const changes = this.history.get(chatKey) ?? [];
      if (changes.length > 0) {
        mkdirSync(join(dir, "history"), { recursive: true, mode: 0o700 });
        appendFileSync(
          join(dir, "history", `${dateStamp(now)}.jsonl`),
          `${changes.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
          { mode: 0o600 },
        );
      }
    }
    const chats = new Set([...this.entries.values()].map((record) => record.chatId ?? "_global"));
    await writeJsonAtomic(join(this.shardDir, "index.json"), {
      version: 1,
      updatedAt: now,
      chats: Object.fromEntries(
        [...chats].map((chatKey) => [
          chatKey,
          {
            records: [...this.entries.values()].filter(
              (record) => (record.chatId ?? "_global") === chatKey,
            ).length,
            updatedAt: now,
          },
        ]),
      ),
    });
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,，。；;、:：!！?？()[\]{}"'`]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)
    .slice(0, 12);
}

function recencyScore(updatedAt: number, now: number, days: number): number {
  const ageDays = (now - updatedAt) / 86_400_000;
  if (ageDays < 0) return 10;
  if (ageDays > days) return 0;
  return 10 * (1 - ageDays / days);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function sanitizeFolder(value: string): string {
  return value.replace(/[/\\:*?"<>|]/g, "_").slice(0, 80) || "_global";
}

function dateStamp(ts: number): string {
  const date = new Date(ts);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
