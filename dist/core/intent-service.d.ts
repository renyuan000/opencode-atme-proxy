import type { AppConfig } from "./config.js";
import type { ChatContextStore } from "./chat-context.js";
import type { Logger } from "./logger.js";
import type { LlmClient, RelevanceService } from "./relevance.js";
import type { ReplyStyleOptions } from "./reply-style.js";
import type { BotIntent, Classification, IncomingMessage } from "./types.js";
export interface IntentServiceOptions {
    config: AppConfig;
    relevance: () => RelevanceService;
    llm: LlmClient;
    filterEnabled: boolean;
    chatContext: ChatContextStore;
    replyOptions: ReplyStyleOptions;
    logger: Logger;
}
export declare class IntentService {
    private readonly options;
    constructor(options: IntentServiceOptions);
    classifyOne(message: IncomingMessage, signal: AbortSignal): Promise<Classification | undefined>;
    decideBotIntent(message: IncomingMessage, signal: AbortSignal): Promise<BotIntent>;
}
