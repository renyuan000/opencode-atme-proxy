import { type ExtractDocumentOptions } from "./document.js";
export type ReadRangeKind = "chars" | "pages" | "sheet" | "section";
export interface ReadRange {
    kind: ReadRangeKind;
    start: number;
    end: number;
}
export interface ExtractedDocument {
    text?: string;
    chars: number;
    truncated: boolean;
    totalPages?: number;
    pagesProcessed: number[];
    readRanges: ReadRange[];
    extractor: string;
    error?: string;
}
export interface FileEnvelope extends ExtractedDocument {
    conversationId: string;
    sha256: string;
    mime: string;
    size: number;
    name?: string;
    localPath?: string;
}
export declare function extractFileEnvelope(input: {
    conversationId: string;
    data: Buffer;
    mime: string;
    name?: string;
    localPath?: string;
    options?: ExtractDocumentOptions;
}): Promise<FileEnvelope>;
export declare function createFileEnvelope(input: {
    conversationId: string;
    data: Buffer;
    mime: string;
    extracted: ExtractedDocument;
    name?: string;
    localPath?: string;
}): FileEnvelope;
