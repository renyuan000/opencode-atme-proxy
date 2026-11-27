import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "./logger.js";
import { createLogger } from "./logger.js";
import { truncateMiddle, toErrorMessage } from "./util.js";

export interface EvidenceRecord {
  ts: number;
  platform: string;
  chatId: string;
  chatName?: string;
  messageId: string;
  replyToMessageId?: string;
  threadId?: string;
  direction: "inbound" | "outbound";
  senderId?: string;
  senderName?: string;
  origin?: string;
  text: string;
  attachments?: Array<{
    kind: string;
    key?: string;
    name?: string;
    size?: number;
    mime?: string;
    localPath?: string;
  }>;
}

export interface EvidenceMessageChain {
  reply: EvidenceRecord[];
  thread: EvidenceRecord[];
}

export interface EvidenceStoreOptions {
  dir: string;
  enabled?: boolean;
  retentionDays: number;
  maxChars: number;
  logger?: Logger;
  now?: () => number;
}

const UNSAFE = /[/\\:*?"<>|]/g;

function sanitize(value: string): string {
  return value.replace(UNSAFE, "_").slice(0, 80);
}

function monthStamp(ts: number): string {
  const date = new Date(ts);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function filePeriodStart(file: string): number {
  const value = file.replace(/\.jsonl$/, "");
  if (/^\d{4}-\d{2}$/.test(value)) return Date.parse(`${value}-01T00:00:00`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return Date.parse(`${value}T00:00:00`);
  return Number.NaN;
}

function filePeriodEnd(file: string): number {
  const value = file.replace(/\.jsonl$/, "");
  if (/^\d{4}-\d{2}$/.test(value)) {
    const [year, month] = value.split("-").map(Number);
    return new Date(year!, month!, 1).getTime();
  }
  const start = filePeriodStart(file);
  return Number.isNaN(start) ? Number.NaN : start + 86_400_000;
}

export class EvidenceStore {
  private readonly enabled: boolean;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly dirs = new Map<string, string>();
  private readonly activeMonths = new Map<string, string>();
  private readonly indexes = new Map<string, Map<string, EvidenceRecord>>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: EvidenceStoreOptions) {
    this.enabled = options.enabled !== false;
    this.logger = options.logger ?? createLogger({ scope: "evidence" });
    this.now = options.now ?? Date.now;
  }

  append(record: EvidenceRecord): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    const entry = {
      ...record,
      text: truncateMiddle(record.text, this.options.maxChars),
    };
    this.writeQueue = this.writeQueue
      .then(async () => {
        const dir = this.chatDir(record.chatId, record.chatName);
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const month = monthStamp(record.ts);
        await appendFile(join(dir, `${month}.jsonl`), `${JSON.stringify(entry)}\n`, {
          mode: 0o600,
        });
        await appendFile(join(dir, "index.jsonl"), `${JSON.stringify(entry)}\n`, {
          mode: 0o600,
        });
        const index = this.indexes.get(record.chatId);
        if (index) index.set(record.messageId, entry);
        let active = this.activeMonths.get(record.chatId);
        if (!active) {
          active = await this.readActiveMonth(dir);
          if (active) this.activeMonths.set(record.chatId, active);
        }
        if (!active || month > active) {
          this.activeMonths.set(record.chatId, month);
          await writeFile(
            join(dir, "pointer.json"),
            `${JSON.stringify({ version: 1, active: month, updatedAt: this.now() })}\n`,
            { encoding: "utf8", mode: 0o600 },
          );
        }
      })
      .catch((error) => {
        this.logger.warn("evidence append failed", {
          chatId: record.chatId,
          messageId: record.messageId,
          error: toErrorMessage(error),
        });
      });
    return this.writeQueue;
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private queueTask<T>(task: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(task, task);
    this.writeQueue = next.then(
      () => undefined,
      (error) => {
        this.logger.warn("evidence queue task failed", {
          error: toErrorMessage(error),
        });
      },
    );
    return next;
  }

  async search(input: {
    chatId: string;
    terms: string[];
    days?: number;
    limit?: number;
  }): Promise<EvidenceRecord[]> {
    if (!this.enabled || input.terms.length === 0) return [];
    await this.flush();
    const terms = input.terms.map((term) => term.toLowerCase()).filter(Boolean);
    const cutoff = this.now() - (input.days ?? 7) * 86_400_000;
    const limit = input.limit ?? 5;
    const results: EvidenceRecord[] = [];
    for (const dir of await this.findChatDirs(input.chatId)) {
      let files: string[];
      try {
        files = (await readdir(dir))
          .filter((file) => file.endsWith(".jsonl") && file !== "index.jsonl")
          .sort()
          .reverse();
      } catch {
        continue;
      }
      for (const file of files) {
        const periodEnd = filePeriodEnd(file);
        if (Number.isNaN(periodEnd) || periodEnd < cutoff) continue;
        let raw: string;
        try {
          raw = await readFile(join(dir, file), "utf8");
        } catch {
          continue;
        }
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          let record: EvidenceRecord;
          try {
            record = JSON.parse(line) as EvidenceRecord;
          } catch {
            continue;
          }
          if (record.ts < cutoff) continue;
          const haystack = record.text.toLowerCase();
          if (!terms.some((term) => haystack.includes(term))) continue;
          results.push(record);
          if (results.length >= limit) return results;
        }
      }
    }
    return results;
  }

  async findByMessageId(input: {
    chatId: string;
    messageId: string;
    days?: number;
  }): Promise<EvidenceRecord | undefined> {
    if (!this.enabled) return undefined;
    const cutoff = this.now() - (input.days ?? 30) * 86_400_000;
    const record = (await this.ensureIndex(input.chatId)).get(input.messageId);
    if (record && record.ts >= cutoff) return record;
    for (const dir of await this.findChatDirs(input.chatId)) {
      let files: string[];
      try {
        files = (await readdir(dir))
          .filter((file) => file.endsWith(".jsonl") && file !== "index.jsonl")
          .sort()
          .reverse();
      } catch {
        continue;
      }
      for (const file of files) {
        const periodEnd = filePeriodEnd(file);
        if (Number.isNaN(periodEnd) || periodEnd < cutoff) continue;
        let raw: string;
        try {
          raw = await readFile(join(dir, file), "utf8");
        } catch {
          continue;
        }
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          try {
            const found = JSON.parse(line) as EvidenceRecord;
            if (found.ts < cutoff) continue;
            if (found.messageId === input.messageId) return found;
          } catch {
            continue;
          }
        }
      }
    }
    return undefined;
  }

  async findReplyChain(input: {
    chatId: string;
    messageId: string;
    maxDepth?: number;
    days?: number;
  }): Promise<EvidenceRecord[]> {
    return (await this.findMessageChain(input)).reply;
  }

  async findMessageChain(input: {
    chatId: string;
    messageId: string;
    maxDepth?: number;
    maxThread?: number;
    days?: number;
  }): Promise<EvidenceMessageChain> {
    if (!this.enabled) return { reply: [], thread: [] };
    const cutoff = this.now() - (input.days ?? 30) * 86_400_000;
    const index = await this.ensureIndex(input.chatId);
    const current = await this.findByMessageId({
      chatId: input.chatId,
      messageId: input.messageId,
      days: input.days,
    });
    const reply: EvidenceRecord[] = [];
    const seen = new Set<string>();
    let id: string | undefined = input.messageId;
    while (id && reply.length < (input.maxDepth ?? 5) && !seen.has(id)) {
      seen.add(id);
      const record = await this.findByMessageId({
        chatId: input.chatId,
        messageId: id,
        days: input.days,
      });
      if (!record || record.ts < cutoff) break;
      reply.push(record);
      id = record.replyToMessageId;
    }
    const threadId = current?.threadId ?? reply[0]?.threadId;
    const thread = threadId
      ? [...index.values()]
          .filter(
            (record) =>
              record.threadId === threadId &&
              record.ts >= cutoff &&
              !seen.has(record.messageId),
          )
          .sort((a, b) => a.ts - b.ts)
          .slice(-(input.maxThread ?? 10))
      : [];
    return { reply, thread };
  }

  private async ensureIndex(chatId: string): Promise<Map<string, EvidenceRecord>> {
    await this.flush();
    const existing = this.indexes.get(chatId);
    if (existing) return existing;
    const index = new Map<string, EvidenceRecord>();
    for (const dir of await this.findChatDirs(chatId)) {
      let raw: string | undefined;
      try {
        raw = await readFile(join(dir, "index.jsonl"), "utf8");
      } catch {
      }
      let indexed = false;
      if (raw) {
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          try {
            const record = JSON.parse(line) as EvidenceRecord;
            if (record.messageId) {
              index.set(record.messageId, record);
              indexed = true;
            }
          } catch {
            continue;
          }
        }
      }
      if (indexed) continue;
      let files: string[];
      try {
        files = (await readdir(dir)).filter(
          (file) => file.endsWith(".jsonl") && file !== "index.jsonl",
        );
      } catch {
        continue;
      }
      for (const file of files) {
        let rawFile: string;
        try {
          rawFile = await readFile(join(dir, file), "utf8");
        } catch {
          continue;
        }
        for (const line of rawFile.split("\n")) {
          if (!line.trim()) continue;
          try {
            const record = JSON.parse(line) as EvidenceRecord;
            if (record.messageId) index.set(record.messageId, record);
          } catch {
            continue;
          }
        }
      }
    }
    this.indexes.set(chatId, index);
    return index;
  }

  async redact(chatId: string, messageId: string): Promise<void> {
    if (!this.enabled) return;
    await this.queueTask(() => this.redactNow(chatId, messageId));
  }

  private async redactNow(chatId: string, messageId: string): Promise<void> {
    for (const dir of await this.findChatDirs(chatId)) {
      let files: string[];
      try {
        files = (await readdir(dir)).filter(
          (file) => file.endsWith(".jsonl") && file !== "index.jsonl",
        );
      } catch {
        continue;
      }
      for (const file of files) {
        const path = join(dir, file);
        try {
          const lines = (await readFile(path, "utf8")).split("\n");
          let changed = false;
          const next = lines.map((line) => {
            if (!line.trim()) return line;
            try {
              const record = JSON.parse(line) as EvidenceRecord;
              if (record.messageId !== messageId) return line;
              changed = true;
              return JSON.stringify({ ...record, text: "[已撤回]", attachments: undefined });
            } catch {
              return line;
            }
          });
          if (changed) {
            await writeFile(path, next.join("\n"), "utf8");
            for (const line of next) {
              if (!line.trim()) continue;
              try {
                const record = JSON.parse(line) as EvidenceRecord;
                if (record.messageId === messageId) {
                  await appendFile(join(dir, "index.jsonl"), `${JSON.stringify(record)}\n`, {
                    mode: 0o600,
                  });
                }
              } catch {
                continue;
              }
            }
            this.indexes.delete(chatId);
          }
        } catch (error) {
          this.logger.warn("evidence redact failed", {
            chatId,
            messageId,
            error: toErrorMessage(error),
          });
        }
      }
    }
  }

  async prune(): Promise<void> {
    if (!this.enabled) return;
    await this.queueTask(() => this.pruneNow());
  }

  private async pruneNow(): Promise<void> {
    const cutoff = this.now() - this.options.retentionDays * 86_400_000;
    let chats: string[];
    try {
      chats = await readdir(this.options.dir);
    } catch {
      return;
    }
    for (const chat of chats) {
      const dir = join(this.options.dir, chat);
      let files: string[];
      try {
        if (!(await stat(dir)).isDirectory()) continue;
        files = await readdir(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const periodEnd = filePeriodEnd(file);
        if (Number.isNaN(periodEnd) || periodEnd >= cutoff) continue;
        try {
          await rm(join(dir, file));
          await rm(join(dir, "index.jsonl"), { force: true });
          this.indexes.delete(chat);
        } catch (error) {
          this.logger.warn("evidence prune failed", {
            file,
            error: toErrorMessage(error),
          });
        }
      }
    }
  }

  private async findChatDirs(chatId: string): Promise<string[]> {
    const suffix = `__${sanitize(chatId)}`;
    try {
      return (await readdir(this.options.dir))
        .filter((name) => name.endsWith(suffix))
        .map((name) => join(this.options.dir, name));
    } catch {
      return [];
    }
  }

  private async readActiveMonth(dir: string): Promise<string | undefined> {
    try {
      const raw = await readFile(join(dir, "pointer.json"), "utf8");
      const parsed = JSON.parse(raw) as { active?: unknown };
      return typeof parsed.active === "string" && /^\d{4}-\d{2}$/.test(parsed.active)
        ? parsed.active
        : undefined;
    } catch {
      return undefined;
    }
  }

  private chatDir(chatId: string, chatName?: string): string {
    const cached = this.dirs.get(chatId);
    if (cached) return cached;
    const name = chatName ? sanitize(chatName) : "群";
    const dir = join(this.options.dir, `${name}__${sanitize(chatId)}`);
    this.dirs.set(chatId, dir);
    return dir;
  }
}
