import type { LlmClient } from "./relevance.js";
import type { AttachmentRef, IncomingMessage } from "./types.js";
export interface MediaClusterCandidate {
    messageId: string;
    senderId: string;
    senderName?: string;
    text: string;
    ocr?: string;
    at: number;
    attachments: AttachmentRef[];
    interleavedSenders: string[];
}
export interface MediaClusterDecision {
    selectedIds: string[];
    confidence: number;
    reason: string;
    usedFallback: boolean;
}
export interface MediaClusterOptions {
    windowSeconds: number;
    maxCandidates: number;
}
export declare function selectMediaCluster(llm: LlmClient, base: IncomingMessage, candidates: MediaClusterCandidate[], options: MediaClusterOptions): Promise<MediaClusterDecision>;
