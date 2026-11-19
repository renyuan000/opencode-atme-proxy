import type { AppConfig } from "./config.js";
import type { ChatContextStore } from "./chat-context.js";
import type { EvidenceStore } from "./evidence-store.js";
import type { Logger } from "./logger.js";
import type { SenderLimiter } from "./sender-limiter.js";
import type { IncomingMessage } from "./types.js";
export interface MessageIngressOptions {
    config: AppConfig;
    logger: Logger;
    dedup: {
        has(key: string, chatId?: string): boolean;
        add(key: string, chatId?: string): void;
        flush(): Promise<void>;
        delete(key: string, chatId?: string): void;
    };
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
    dispatch(message: IncomingMessage, limited: boolean, wait: boolean, force: boolean): Promise<void>;
}
export declare class MessageIngress {
    private readonly options;
    constructor(options: MessageIngressOptions);
    handle(message: IncomingMessage, _chatName: string, wait?: boolean, force?: boolean): Promise<void>;
    private shouldStoreContext;
    private isMediaMessage;
    private isMentionMe;
    private isMentionBot;
}
