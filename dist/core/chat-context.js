import { createLogger } from "./logger.js";
import { readJsonFile, writeJsonAtomic, toErrorMessage, truncateMiddle } from "./util.js";
export class ChatContextStore {
    options;
    chats = new Map();
    dirty = false;
    logger;
    now;
    constructor(options) {
        this.options = options;
        this.logger = options.logger ?? createLogger({ scope: "chat-context" });
        this.now = options.now ?? Date.now;
    }
    async load() {
        try {
            const data = await readJsonFile(this.options.file, {
                version: 1,
                chats: {},
            });
            const now = this.now();
            for (const [key, value] of Object.entries(data.chats ?? {})) {
                if (!value || !Array.isArray(value.messages))
                    continue;
                if (now - (value.updatedAt ?? 0) > this.options.ttlMs)
                    continue;
                this.chats.set(key, value);
            }
            this.prune();
        }
        catch (error) {
            this.logger.error("failed to load chat context; starting empty", {
                error: toErrorMessage(error),
            });
        }
    }
    get(chatKey) {
        return this.chats.get(chatKey);
    }
    append(chatKey, message, meta) {
        const existing = this.chats.get(chatKey) ??
            {
                platform: meta?.platform ?? "unknown",
                chatId: meta?.chatId ?? chatKey,
                ...(meta?.chatName ? { chatName: meta.chatName } : {}),
                messages: [],
                updatedAt: this.now(),
            };
        const entry = {
            ...message,
            text: truncateMiddle(message.text, this.options.maxCharsPerMessage),
        };
        const index = existing.messages.findIndex((item) => item.messageId === message.messageId);
        if (index >= 0)
            existing.messages[index] = entry;
        else
            existing.messages.push(entry);
        if (existing.messages.length > this.options.maxMessagesPerChat) {
            existing.messages = existing.messages.slice(-this.options.maxMessagesPerChat);
        }
        existing.updatedAt = this.now();
        this.chats.set(chatKey, existing);
        this.dirty = true;
        this.prune();
    }
    bindProject(chatKey, projectId, worktree) {
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
    recent(chatKey, limit, excludeMessageId) {
        const chat = this.chats.get(chatKey);
        if (!chat)
            return [];
        const messages = excludeMessageId
            ? chat.messages.filter((message) => message.messageId !== excludeMessageId)
            : chat.messages;
        return messages.slice(-limit);
    }
    find(chatKey, messageIds) {
        const chat = this.chats.get(chatKey);
        if (!chat || messageIds.length === 0)
            return [];
        const wanted = new Set(messageIds);
        return chat.messages.filter((message) => wanted.has(message.messageId));
    }
    prune() {
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
                if (!entry)
                    break;
                this.chats.delete(entry[0]);
                this.dirty = true;
            }
        }
    }
    async flush() {
        if (!this.dirty)
            return;
        this.prune();
        await writeJsonAtomic(this.options.file, {
            version: 1,
            chats: Object.fromEntries(this.chats),
        });
        this.dirty = false;
    }
}
//# sourceMappingURL=chat-context.js.map