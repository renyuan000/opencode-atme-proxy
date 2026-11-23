import { createLogger } from "./logger.js";
import type { Logger } from "./logger.js";
import { readJsonFile, writeJsonAtomic } from "./util.js";
import type { GroupStateLayout } from "./group-state.js";

export interface DmContext {
  chatId: string;
  summary: string;
  preferences: string[];
  decisions: string[];
  ongoingGoals: string[];
  openQuestions: string[];
  lastMessageAt: number;
  updatedAt: number;
  sessionEpoch: number;
}

interface DmContextFile {
  version: 1;
  conversations: Record<string, DmContext>;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function normalize(raw: Partial<DmContext> | undefined, chatId: string): DmContext | undefined {
  if (!raw || raw.chatId !== chatId) return undefined;
  return {
    chatId,
    summary: typeof raw.summary === "string" ? raw.summary : "",
    preferences: stringArray(raw.preferences),
    decisions: stringArray(raw.decisions),
    ongoingGoals: stringArray(raw.ongoingGoals),
    openQuestions: stringArray(raw.openQuestions),
    lastMessageAt:
      typeof raw.lastMessageAt === "number" && Number.isFinite(raw.lastMessageAt)
        ? raw.lastMessageAt
        : 0,
    updatedAt:
      typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt)
        ? raw.updatedAt
        : Date.now(),
    sessionEpoch:
      typeof raw.sessionEpoch === "number" && Number.isFinite(raw.sessionEpoch)
        ? Math.max(1, Math.floor(raw.sessionEpoch))
        : 1,
  };
}

export class DmContextStore {
  private conversations = new Map<string, DmContext>();
  private dirty = false;
  private readonly logger: Logger;

  constructor(
    private readonly file: string,
    logger?: Logger,
  ) {
    this.logger = logger ?? createLogger({ scope: "dm-context" });
  }

  async load(): Promise<void> {
    try {
      const data = await readJsonFile<DmContextFile>(this.file, {
        version: 1,
        conversations: {},
      });
      for (const [chatId, raw] of Object.entries(data.conversations ?? {})) {
        const context = normalize(raw, chatId);
        if (context) this.conversations.set(chatId, context);
      }
    } catch (error) {
      this.logger.error("failed to load dm context; starting empty", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  get(chatId: string): DmContext | undefined {
    return this.conversations.get(chatId);
  }

  set(context: DmContext): void {
    this.conversations.set(context.chatId, context);
    this.dirty = true;
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    await writeJsonAtomic(this.file, {
      version: 1,
      conversations: Object.fromEntries(this.conversations),
    } satisfies DmContextFile);
    this.dirty = false;
  }
}

export class ScopedDmContext {
  private readonly stores = new Map<string, DmContextStore>();
  private readonly logger: Logger;

  constructor(
    private readonly layout: GroupStateLayout,
    logger?: Logger,
  ) {
    this.logger = logger ?? createLogger({ scope: "dm-context" });
  }

  async load(): Promise<void> {
    for (const info of this.layout.all()) {
      const store = this.store(info.chatId);
      await store.load();
    }
  }

  get(chatId: string): DmContext | undefined {
    return this.store(chatId).get(chatId);
  }

  set(context: DmContext): void {
    this.store(context.chatId).set(context);
  }

  async flush(): Promise<void> {
    await Promise.all([...this.stores.values()].map((store) => store.flush()));
  }

  private store(chatId: string): DmContextStore {
    const existing = this.stores.get(chatId);
    if (existing) return existing;
    const store = new DmContextStore(
      `${this.layout.dirFor(chatId)}/dm-context.json`,
      this.logger,
    );
    this.stores.set(chatId, store);
    return store;
  }
}
