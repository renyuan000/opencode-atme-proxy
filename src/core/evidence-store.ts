import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
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
  direction: "inbound" | "outbound";
  senderId?: string;
  senderName?: string;
  origin?: string;
  text: string;
  attachments?: Array<{ kind: string; name?: string; size?: number }>;
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

function dateStamp(ts: number): string {
  const date = new Date(ts);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export class EvidenceStore {
  private readonly enabled: boolean;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly dirs = new Map<string, string>();

  constructor(private readonly options: EvidenceStoreOptions) {
    this.enabled = options.enabled !== false;
    this.logger = options.logger ?? createLogger({ scope: "evidence" });
    this.now = options.now ?? Date.now;
  }

  append(record: EvidenceRecord): void {
    if (!this.enabled) return;
    try {
      const dir = this.chatDir(record.chatId, record.chatName);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const entry = {
        ...record,
        text: truncateMiddle(record.text, this.options.maxChars),
      };
      appendFileSync(join(dir, `${dateStamp(record.ts)}.jsonl`), `${JSON.stringify(entry)}\n`, {
        mode: 0o600,
      });
    } catch (error) {
      this.logger.warn("evidence append failed", {
        chatId: record.chatId,
        messageId: record.messageId,
        error: toErrorMessage(error),
      });
    }
  }

  search(input: {
    chatId: string;
    terms: string[];
    days?: number;
    limit?: number;
  }): EvidenceRecord[] {
    if (!this.enabled || input.terms.length === 0) return [];
    const terms = input.terms.map((term) => term.toLowerCase()).filter(Boolean);
    const cutoff = this.now() - (input.days ?? 7) * 86_400_000;
    const limit = input.limit ?? 5;
    const results: EvidenceRecord[] = [];
    for (const dir of this.findChatDirs(input.chatId)) {
      let files: string[];
      try {
        files = readdirSync(dir).filter((file) => file.endsWith(".jsonl")).sort().reverse();
      } catch {
        continue;
      }
      for (const file of files) {
        const stamp = file.slice(0, 10);
        const ts = Date.parse(`${stamp}T00:00:00`);
        if (Number.isNaN(ts) || ts < cutoff) continue;
        let raw: string;
        try {
          raw = readFileSync(join(dir, file), "utf8");
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
          const haystack = record.text.toLowerCase();
          if (!terms.some((term) => haystack.includes(term))) continue;
          results.push(record);
          if (results.length >= limit) return results;
        }
      }
    }
    return results;
  }

  findByMessageId(input: {
    chatId: string;
    messageId: string;
    days?: number;
  }): EvidenceRecord | undefined {
    if (!this.enabled) return undefined;
    const cutoff = this.now() - (input.days ?? 30) * 86_400_000;
    for (const dir of this.findChatDirs(input.chatId)) {
      let files: string[];
      try {
        files = readdirSync(dir).filter((file) => file.endsWith(".jsonl")).sort().reverse();
      } catch {
        continue;
      }
      for (const file of files) {
        const stamp = file.slice(0, 10);
        const ts = Date.parse(`${stamp}T00:00:00`);
        if (Number.isNaN(ts) || ts < cutoff) continue;
        let raw: string;
        try {
          raw = readFileSync(join(dir, file), "utf8");
        } catch {
          continue;
        }
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          try {
            const record = JSON.parse(line) as EvidenceRecord;
            if (record.messageId === input.messageId) return record;
          } catch {
            continue;
          }
        }
      }
    }
    return undefined;
  }

  prune(): void {
    if (!this.enabled) return;
    const cutoff = this.now() - this.options.retentionDays * 86_400_000;
    let chats: string[];
    try {
      chats = readdirSync(this.options.dir);
    } catch {
      return;
    }
    for (const chat of chats) {
      const dir = join(this.options.dir, chat);
      let files: string[];
      try {
        if (!statSync(dir).isDirectory()) continue;
        files = readdirSync(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const stamp = file.slice(0, 10);
        const ts = Date.parse(`${stamp}T00:00:00`);
        if (Number.isNaN(ts) || ts >= cutoff) continue;
        try {
          rmSync(join(dir, file));
        } catch (error) {
          this.logger.warn("evidence prune failed", {
            file,
            error: toErrorMessage(error),
          });
        }
      }
    }
  }

  private findChatDirs(chatId: string): string[] {
    const suffix = `__${sanitize(chatId)}`;
    try {
      return readdirSync(this.options.dir)
        .filter((name) => name.endsWith(suffix))
        .map((name) => join(this.options.dir, name));
    } catch {
      return [];
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
