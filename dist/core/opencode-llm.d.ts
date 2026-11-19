import type { Logger } from "./logger.js";
import type { OpenCodeBridge } from "./opencode.js";
import type { LlmClient, LlmCompletion, LlmMessage } from "./relevance.js";
export interface OpenCodeLlmOptions {
    bridge: OpenCodeBridge;
    directory: string;
    titlePrefix: string;
    agent?: string;
    model?: {
        providerID: string;
        modelID: string;
    };
    logger?: Logger;
}
export declare class OpenCodeLlmClient implements LlmClient {
    private readonly options;
    private readonly logger;
    constructor(options: OpenCodeLlmOptions);
    complete(messages: LlmMessage[], signal?: AbortSignal): Promise<LlmCompletion>;
}
