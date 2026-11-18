import type { AppConfig } from "./config.js";
import type { DedupStore } from "./dedup.js";
import type { ChatContextStore } from "./chat-context.js";
import type { EvidenceStore } from "./evidence-store.js";
import type { Logger } from "./logger.js";
import type { SenderLimiter } from "./sender-limiter.js";
import type { IncomingMessage } from "./types.js";
export interface MessageIngressOptions {
    config: AppConfig;
    logger: Logger;
    dedup: DedupStore;
    chatContext: ChatContextStore;
    evidence: EvidenceStore;
    senderLimiter: SenderLimiter;
    activeMessageIds: Set<string>;
    ownerOpenId(): string | undefined;
    botOpenId(): string | undefined;
    rememberRecent(message: IncomingMessage): void;
    updateGroupSummary(platform: string, chatId: string): void;
    acknowledge?(message: IncomingMessage): Promise<void>;
    safeReply(message: IncomingMessage, text: string): Promise<boolean>;
    dispatch(message: IncomingMessage, limited: boolean, wait: boolean): Promise<void>;
}
export declare class MessageIngress {
    private readonly options;
    constructor(options: MessageIngressOptions);
    handle(message: IncomingMessage, _chatName: string, wait?: boolean): Promise<void>;
    private shouldStoreContext;
    private isMediaMessage;
    private isMentionMe;
    private isMentionBot;
}
