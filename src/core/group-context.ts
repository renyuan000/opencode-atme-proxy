import { createLogger } from "./logger.js";
import type { Logger } from "./logger.js";
import { readJsonFile, writeJsonAtomic, toErrorMessage } from "./util.js";

export interface GroupTopic {
  title: string;
  summary?: string;
  phase?: string;
  status: "active" | "paused" | "done";
  messageIds?: string[];
}

export interface GroupSummary {
  chatId: string;
  conversationId?: string;
  summary: string;
  decisions: string[];
  assumptions: string[];
  openQuestions: string[];
  topics?: GroupTopic[];
  lastMessageAt: number;
  updatedAt: number;
}

interface GroupContextFile {
  version: 1;
  chats: Record<string, GroupSummary>;
}

export class GroupContextStore {
  private chats = new Map<string, GroupSummary>();
  private dirty = false;
  private readonly logger: Logger;

  constructor(
    private readonly file: string,
    logger?: Logger,
  ) {
    this.logger = logger ?? createLogger({ scope: "group-context" });
  }

  async load(): Promise<void> {
    try {
      const data = await readJsonFile<GroupContextFile>(this.file, { version: 1, chats: {} });
      for (const [chatId, summary] of Object.entries(data.chats ?? {})) {
        if (summary && typeof summary.summary === "string") {
          this.chats.set(chatId, summary);
        }
      }
    } catch (error) {
      this.logger.error("failed to load group context; starting empty", {
        error: toErrorMessage(error),
      });
    }
  }

  get(chatId: string): GroupSummary | undefined {
    return this.chats.get(chatId);
  }

  set(chatId: string, summary: GroupSummary): void {
    this.chats.set(chatId, summary);
    this.dirty = true;
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    await writeJsonAtomic(this.file, {
      version: 1,
      chats: Object.fromEntries(this.chats),
    } satisfies GroupContextFile);
    this.dirty = false;
  }

  size(): number {
    return this.chats.size;
  }

  list(): GroupSummary[] {
    return [...this.chats.values()];
  }
}
