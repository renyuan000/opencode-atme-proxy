import type { ExtractedDocument } from "./file-envelope.js";
export declare function extractDocument(data: Buffer, mime: string, name?: string): Promise<ExtractedDocument>;
export declare function extractDocumentText(data: Buffer, mime: string, name?: string): Promise<string | undefined>;
