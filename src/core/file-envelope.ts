import { createHash } from "node:crypto";

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
