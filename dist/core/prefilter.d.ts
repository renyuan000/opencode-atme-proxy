import type { IncomingMessage, PrefilterResult } from "./types.js";
export interface PrefilterContext {
    ownerId?: string;
    botId?: string;
    ownerKeywords?: string[];
    coreProjects?: string[];
    referenceProjects?: string[];
    ownerDirection?: string;
}
export declare function prefilterMessage(message: IncomingMessage, context?: PrefilterContext): PrefilterResult;
