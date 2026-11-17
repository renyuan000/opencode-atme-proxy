import type { Logger } from "./logger.js";
export type ContextOrigin = "mention_me" | "mention_bot" | "scan_relevant" | "owner_dm" | "media_placeholder";
export interface ContextMessage {
    messageId: string;
    senderId: string;
    senderName?: string;
    text: string;
    at: number;
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
export interface ChatContextStoreOptions {
    file: string;
    maxMessagesPerChat: number;
    maxCharsPerMessage: number;
    maxChats: number;
    ttlMs: number;
    logger?: Logger;
    now?: () => number;
}
export declare class ChatContextStore {
    private readonly options;
    private chats;
    private dirty;
    private readonly logger;
    private readonly now;
    constructor(options: ChatContextStoreOptions);
    load(): Promise<void>;
    get(chatKey: string): ChatContext | undefined;
    append(chatKey: string, message: ContextMessage, meta?: Pick<ChatContext, "platform" | "chatId" | "chatName">): void;
    bindProject(chatKey: string, projectId: string, worktree: string): void;
    recent(chatKey: string, limit: number, excludeMessageId?: string): ContextMessage[];
    find(chatKey: string, messageIds: string[]): ContextMessage[];
    prune(): void;
    flush(): Promise<void>;
}
