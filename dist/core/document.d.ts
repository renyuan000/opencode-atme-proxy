import type { ExtractedDocument } from "./file-envelope.js";
export declare const DEFAULT_MAX_EXTRACT_CHARS = 20000;
export interface ExtractDocumentOptions {
    maxChars?: number;
    maxBytes?: number;
    timeoutMs?: number;
}
export declare function extractDocument(data: Buffer, mime: string, name?: string, options?: ExtractDocumentOptions): Promise<ExtractedDocument>;
export declare function extractDocumentText(data: Buffer, mime: string, name?: string, options?: ExtractDocumentOptions): Promise<string | undefined>;
