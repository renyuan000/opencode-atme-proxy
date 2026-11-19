import type { AppConfig } from "./config.js";
import type { DedupStore } from "./dedup.js";
import type { EvidenceStore } from "./evidence-store.js";
import type { Logger } from "./logger.js";
import type { OpenCodeBridge } from "./opencode.js";
import type { PlatformAdapter } from "./ports.js";
import type { TokenBucket } from "./rate-limit.js";
import type { IncomingMessage } from "./types.js";
import type { SentReplyStore } from "./sent-reply-store.js";
export interface NotificationServiceOptions {
    config: AppConfig;
    logger: Logger;
    platform: PlatformAdapter;
    bridge: OpenCodeBridge;
    sendLimiter: TokenBucket;
    evidence: EvidenceStore;
    outbound: DedupStore;
    sentReplies: SentReplyStore;
    chatNames: Map<string, {
        name: string;
        at: number;
    }>;
    ownerOpenId(): string | undefined;
}
export declare class NotificationService {
    private readonly options;
    constructor(options: NotificationServiceOptions);
    sendToOwner(text: string, sourceMessageId?: string): Promise<boolean>;
    sendToApprover(text: string): Promise<boolean>;
    safeReply(message: IncomingMessage, text: string): Promise<boolean>;
    chatLabel(message: IncomingMessage): Promise<string>;
    rememberChatName(chatId: string, name: string): void;
    fetchChatName(chatId: string): Promise<string | undefined>;
}
