import type { IncomingMessage } from "./types.js";
import type { LlmClient } from "./relevance.js";
export interface BurstGroupResult {
    selected: IncomingMessage[];
    rejected: IncomingMessage[];
    reason: string;
    usedFallback: boolean;
}
export declare function selectBurstExtensions(llm: LlmClient, base: IncomingMessage, candidates: IncomingMessage[]): Promise<BurstGroupResult>;
