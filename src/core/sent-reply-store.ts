import { createLogger } from "./logger.js";
import type { Logger } from "./logger.js";
import { readJsonFile, writeJsonAtomic } from "./util.js";

export interface SentReplyRecord {
  id: string;
  platform: string;
  chatId: string;
  chatName?: string;
  senderLabel: string;
  sourceMessageId: string;
  sentMessageId: string;
  text: string;
  sourceText: string;
  sentAt: number;
  status: "sent" | "recalled";
  recalledAt?: number;
}

interface SentReplyFile {
  version: 1;
  replies: SentReplyRecord[];
}

export class SentReplyStore {
  private readonly logger: Logger;
  private replies: SentReplyRecord[] = [];
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly ttlMs = 7 * 24 * 3600_000,
    private readonly maxEntries = 50,
    logger?: Logger,
  ) {
    this.logger = logger ?? createLogger({ scope: "sent-replies" });
  }

  async load(): Promise<void> {
    try {
      const data = await readJsonFile<SentReplyFile>(this.file, {
        version: 1,
        replies: [],
      });
      const cutoff = Date.now() - this.ttlMs;
      this.replies = (Array.isArray(data.replies) ? data.replies : [])
        .filter(
          (item): item is SentReplyRecord =>
            Boolean(item) &&
            typeof item.id === "string" &&
            typeof item.chatId === "string" &&
            typeof item.sentMessageId === "string" &&
            typeof item.text === "string" &&
            typeof item.sentAt === "number" &&
            item.sentAt >= cutoff,
        )
        .slice(0, this.maxEntries);
    } catch (error) {
      this.replies = [];
      this.logger.error("failed to load sent replies; starting empty", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  list(limit = 5): SentReplyRecord[] {
    return this.replies.slice(0, Math.max(0, limit));
  }

  listRecallable(limit = 5, now = Date.now()): SentReplyRecord[] {
    const windowMs = 24 * 3600_000;
    return this.replies
      .filter((item) => item.status === "sent" && now - item.sentAt <= windowMs)
      .slice(0, Math.max(0, limit));
  }

  get(id: string): SentReplyRecord | undefined {
    return this.replies.find((item) => item.id === id);
  }

  hasSource(sourceMessageId: string): boolean {
    return this.replies.some(
      (item) => item.status === "sent" && item.sourceMessageId === sourceMessageId,
    );
  }

  async add(input: Omit<SentReplyRecord, "id" | "status">): Promise<SentReplyRecord> {
    const record: SentReplyRecord = {
      ...input,
      id: `sent_${input.sentMessageId.slice(-12)}_${input.sentAt}`,
      status: "sent",
    };
    this.replies = [
      record,
      ...this.replies.filter((item) => item.sentMessageId !== record.sentMessageId),
    ].slice(0, this.maxEntries);
    await this.flush();
    return record;
  }

  async markRecalled(id: string, at = Date.now()): Promise<boolean> {
    const record = this.get(id);
    if (!record || record.status === "recalled") return false;
    record.status = "recalled";
    record.recalledAt = at;
    await this.flush();
    return true;
  }

  async flush(): Promise<void> {
    this.chain = this.chain
      .catch(() => {})
      .then(async () => {
        await writeJsonAtomic(this.file, {
          version: 1,
          replies: this.replies,
        } satisfies SentReplyFile);
      })
      .catch((error) => {
        this.logger.error("failed to persist sent replies", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    await this.chain;
  }
}
