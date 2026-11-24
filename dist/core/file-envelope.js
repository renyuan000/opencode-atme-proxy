import { createHash } from "node:crypto";
import { extractDocument } from "./document.js";
export async function extractFileEnvelope(input) {
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
export function createFileEnvelope(input) {
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
//# sourceMappingURL=file-envelope.js.map