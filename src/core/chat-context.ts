import { createLogger } from "./logger.js";
import type { Logger } from "./logger.js";
import { readJsonFile, writeJsonAtomic, toErrorMessage, truncateMiddle } from "./util.js";

export type ContextOrigin =
  | "mention_me"
  | "mention_bot"
  | "scan_relevant"
  | "owner_dm"
  | "owner_group"
  | "media_placeholder";

export interface ContextMessage {
  messageId: string;
  senderId: string;
  senderName?: string;
  text: string;
  at: number;
  replyToMessageId?: string;
  threadId?: string;
  mentionMe: boolean;
  mentionBot: boolean;
  origin?: ContextOrigin;
}

export interface ChatContext {
  platform: string;
  chatId: string;
  chatName?: string;
  projectId?: string;
  worktree?: string;
  messages: ContextMessage[];
  updatedAt: number;
}

interface ContextFile {
  version: 1;
  chats: Record<string, ChatContext>;
}

export interface ChatContextStoreOptions {
  file: string;
  maxMessagesPerChat: number;
  maxCharsPerMessage: number;
  maxChats: number;
  ttlMs: number;
  logger?: Logger;
  now?: () => number;
}

export class ChatContextStore {
  private chats = new Map<string, ChatContext>();
  private dirty = false;
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(private readonly options: ChatContextStoreOptions) {
    this.logger = options.logger ?? createLogger({ scope: "chat-context" });
    this.now = options.now ?? Date.now;
  }

  async load(): Promise<void> {
    try {
      const data = await readJsonFile<ContextFile>(this.options.file, {
        version: 1,
        chats: {},
      });
      const now = this.now();
      for (const [key, value] of Object.entries(data.chats ?? {})) {
        if (!value || !Array.isArray(value.messages)) continue;
        if (now - (value.updatedAt ?? 0) > this.options.ttlMs) continue;
        this.chats.set(key, value);
      }
      this.prune();
    } catch (error) {
      this.logger.error("failed to load chat context; starting empty", {
        error: toErrorMessage(error),
      });
    }
  }

  get(chatKey: string): ChatContext | undefined {
    return this.chats.get(chatKey);
  }

  append(chatKey: string, message: ContextMessage, meta?: Pick<ChatContext, "platform" | "chatId" | "chatName">): void {
    const existing =
      this.chats.get(chatKey) ??
      ({
        platform: meta?.platform ?? "unknown",
        chatId: meta?.chatId ?? chatKey,
        ...(meta?.chatName ? { chatName: meta.chatName } : {}),
        messages: [],
        updatedAt: this.now(),
      } satisfies ChatContext);
    existing.messages.push({
      ...message,
      text: truncateMiddle(message.text, this.options.maxCharsPerMessage),
    });
    if (existing.messages.length > this.options.maxMessagesPerChat) {
      existing.messages = existing.messages.slice(-this.options.maxMessagesPerChat);
    }
    existing.updatedAt = this.now();
    this.chats.set(chatKey, existing);
    this.dirty = true;
    this.prune();
  }

  bindProject(chatKey: string, projectId: string, worktree: string): void {
    const existing = this.chats.get(chatKey);
    if (!existing) {
      this.chats.set(chatKey, {
        platform: chatKey.split(":")[0] ?? "unknown",
        chatId: chatKey,
        projectId,
        worktree,
        messages: [],
        updatedAt: this.now(),
      });
      this.dirty = true;
      return;
    }
    existing.projectId = projectId;
    existing.worktree = worktree;
    existing.updatedAt = this.now();
    this.dirty = true;
  }

  recent(chatKey: string, limit: number, excludeMessageId?: string): ContextMessage[] {
    const chat = this.chats.get(chatKey);
    if (!chat) return [];
    const messages = excludeMessageId
      ? chat.messages.filter((message) => message.messageId !== excludeMessageId)
      : chat.messages;
    return messages.slice(-limit);
  }

  find(chatKey: string, messageIds: string[]): ContextMessage[] {
    const chat = this.chats.get(chatKey);
    if (!chat || messageIds.length === 0) return [];
    const wanted = new Set(messageIds);
    return chat.messages.filter((message) => wanted.has(message.messageId));
  }

  prune(): void {
    const now = this.now();
    for (const [key, chat] of this.chats) {
      if (now - chat.updatedAt > this.options.ttlMs) {
        this.chats.delete(key);
        this.dirty = true;
      }
    }
    if (this.chats.size > this.options.maxChats) {
      const sorted = [...this.chats.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
      const excess = this.chats.size - this.options.maxChats;
      for (let index = 0; index < excess; index++) {
        const entry = sorted[index];
        if (!entry) break;
        this.chats.delete(entry[0]);
        this.dirty = true;
      }
    }
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.prune();
    await writeJsonAtomic(this.options.file, {
      version: 1,
      chats: Object.fromEntries(this.chats),
    } satisfies ContextFile);
    this.dirty = false;
  }
}
