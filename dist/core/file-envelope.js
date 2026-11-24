import { createHash } from "node:crypto";
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