import { createLogger } from "./logger.js";
import type { Logger } from "./logger.js";
import type { ApprovalView } from "./types.js";
import { readJsonFile, writeJsonAtomic, toErrorMessage } from "./util.js";

export interface PendingCard {
  platform: string;
  taskId: string;
  mode: "reply" | "develop";
  planHash: string;
  analysisVersion: number;
  actorId: string;
  chatId?: string;
  messageId?: string;
  sourceMessageId?: string;
  style?: "concise" | "detailed";
  draft?: string;
  view?: ApprovalView;
  createdAt: number;
}

interface PendingFile {
  version: 1;
  cards: Record<string, PendingCard>;
}

export class PendingStore {
  private cards = new Map<string, PendingCard>();
  private dirty = false;
  private readonly logger: Logger;

  constructor(
    private readonly file: string,
    logger?: Logger,
  ) {
    this.logger = logger ?? createLogger({ scope: "pending" });
  }

  async load(): Promise<void> {
    try {
      const data = await readJsonFile<PendingFile>(this.file, { version: 1, cards: {} });
      for (const [key, card] of Object.entries(data.cards ?? {})) {
        if (card && typeof card.taskId === "string" && typeof card.planHash === "string") {
          this.cards.set(key, card);
        }
      }
    } catch (error) {
      this.logger.error("failed to load pending cards; starting empty", {
        error: toErrorMessage(error),
      });
    }
  }

  get(key: string): PendingCard | undefined {
    return this.cards.get(key);
  }

  findForTask(taskId: string): PendingCard | undefined {
    for (const card of this.cards.values()) {
      if (card.taskId === taskId) return card;
    }
    return undefined;
  }

  set(key: string, card: PendingCard): void {
    this.cards.set(key, card);
    this.dirty = true;
  }

  delete(key: string): void {
    if (this.cards.delete(key)) this.dirty = true;
  }

  snapshot(): Array<[string, PendingCard]> {
    return [...this.cards.entries()];
  }

  deleteForTask(taskId: string): void {
    for (const [key, card] of this.cards) {
      if (card.taskId === taskId) {
        this.cards.delete(key);
        this.dirty = true;
      }
    }
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    await writeJsonAtomic(this.file, {
      version: 1,
      cards: Object.fromEntries(this.cards),
    } satisfies PendingFile);
    this.dirty = false;
  }
}
