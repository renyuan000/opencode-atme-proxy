import { createHash } from "node:crypto";
import { extractDocument, type ExtractDocumentOptions } from "./document.js";

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

export async function extractFileEnvelope(input: {
  conversationId: string;
  data: Buffer;
  mime: string;
  name?: string;
  localPath?: string;
  options?: ExtractDocumentOptions;
}): Promise<FileEnvelope> {
  const extracted = await extractDocument(input.data, input.mime, input.name, input.options);
  return createFileEnvelope({
    conversationId: input.conversationId,
    data: input.data,
    mime: input.mime,
    extracted,
    ...(input.name ? { name: input.name } : {}),
    ...(input.localPath ? { localPath: input.localPath } : {}),
  });
}

export function createFileEnvelope(input: {
  conversationId: string;
  data: Buffer;
  mime: string;
  extracted: ExtractedDocument;
  name?: string;
  localPath?: string;
}): FileEnvelope {
  return {
    conversationId: input.conversationId,
    sha256: createHash("sha256").update(input.data).digest("hex"),
    mime: input.mime,
    size: input.data.length,
    ...(input.name ? { name: input.name } : {}),
    ...(input.localPath ? { localPath: input.localPath } : {}),
    ...input.extracted,
  };
}
