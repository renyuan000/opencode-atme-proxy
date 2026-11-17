import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
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

  private chatDir(chatId: string, chatName?: string): string {
    const cached = this.dirs.get(chatId);
    if (cached) return cached;
    const name = chatName ? sanitize(chatName) : "群";
    const dir = join(this.options.dir, `${name}__${sanitize(chatId)}`);
    this.dirs.set(chatId, dir);
    return dir;
  }
}
