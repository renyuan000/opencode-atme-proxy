import type { BotIntent, Classification, FilterStats, IncomingMessage } from "./types.js";
import type { Logger } from "./logger.js";
export interface HistoryMessage {
    sender: string;
    text: string;
    time: number;
}
export interface LlmMessage {
    role: "system" | "user";
    content: string;
}
export interface LlmUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
}
export interface LlmCompletion {
    text: string;
    usage: LlmUsage;
    model: string;
}
export interface LlmClient {
    complete(messages: LlmMessage[], signal?: AbortSignal): Promise<LlmCompletion>;
}
export interface OpenAiCompatibleOptions {
    baseUrl: string;
    apiKey: string;
    model: string;
    timeoutMs: number;
    logger?: Logger;
}
export declare class OpenAiCompatibleClient implements LlmClient {
    private readonly options;
    private readonly logger;
    constructor(options: OpenAiCompatibleOptions);
    complete(messages: LlmMessage[], signal?: AbortSignal): Promise<LlmCompletion>;
    private post;
}
export interface Profile {
    name?: string;
    role?: string;
    keywords: string[];
    projects: string[];
    tasks: string[];
}
export interface KeywordRule {
    include: string[];
    exclude: string[];
}
export interface RelevanceOptions {
    llm: LlmClient;
    profile: Profile;
    keywords: KeywordRule;
    meOpenId?: string;
    botOpenId?: string;
    keywordPrefilter: boolean;
    maxMessagesPerBatch: number;
    maxCharsPerMessage: number;
    minTaskConfidence: number;
    minReviewConfidence: number;
    projectContext?(chatId: string): {
        core: string[];
        reference: string[];
    };
    logger?: Logger;
}
export interface BotIntentInput {
    text: string;
    history: string[];
    profile: Profile;
    allowNoReply: boolean;
}
export declare function parseBotIntent(raw: string, input: BotIntentInput): BotIntent;
export declare function buildBotIntentPrompt(input: BotIntentInput): LlmMessage[];
export declare class RelevanceService {
    private readonly options;
    private readonly logger;
    constructor(options: RelevanceOptions);
    prefilter(message: IncomingMessage): {
        hit: boolean;
        matched: string[];
    };
    classify(messages: IncomingMessage[], signal?: AbortSignal, history?: HistoryMessage[]): Promise<{
        items: Classification[];
        stats: FilterStats;
    }>;
    private chunk;
    private classifyBatch;
}
export declare function parseClassification(raw: string, batch: IncomingMessage[], options: Pick<RelevanceOptions, "minTaskConfidence" | "minReviewConfidence">): {
    items: Classification[];
    missingIds: string[];
};
export declare function parseJsonLoose(raw: string): any;
export declare function makeDedupKey(input: {
    platform: string;
    chatId: string;
    title: string;
    project?: string;
    requesterId: string;
}): string;
