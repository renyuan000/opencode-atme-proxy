import { createLogger } from "./logger.js";
import { toErrorMessage } from "./util.js";
export class OpenCodeLlmClient {
    options;
    logger;
    constructor(options) {
        this.options = options;
        this.logger = options.logger ?? createLogger({ scope: "opencode-llm" });
    }
    async complete(messages, signal) {
        const system = messages.find((message) => message.role === "system")?.content ?? "";
        const user = messages.find((message) => message.role === "user")?.content ?? "";
        const title = `${this.options.titlePrefix}:filter:${Date.now()}`;
        const sessionId = await this.options.bridge.createSession({
            directory: this.options.directory,
            title,
            ...(this.options.agent ? { agent: this.options.agent } : {}),
            ...(this.options.model ? { model: this.options.model } : {}),
            permission: [
                { permission: "edit", pattern: "*", action: "deny" },
                { permission: "bash", pattern: "*", action: "deny" },
                { permission: "webfetch", pattern: "*", action: "deny" },
                { permission: "websearch", pattern: "*", action: "deny" },
                { permission: "external_directory", pattern: "*", action: "deny" },
            ],
        });
        const timeoutMs = this.options.timeoutMs ?? 60_000;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error(`filter timed out after ${timeoutMs}ms`)), timeoutMs);
        const onAbort = () => controller.abort(signal?.reason);
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
            const text = await this.options.bridge.prompt(sessionId, {
                directory: this.options.directory,
                title,
                text: system ? `${system}\n\n${user}` : user,
                signal: controller.signal,
            });
            return {
                text,
                model: "opencode",
                usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            };
        }
        finally {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            await this.options.bridge.deleteSession(sessionId).catch((error) => {
                this.logger.warn("failed to delete filter session", {
                    sessionId,
                    error: toErrorMessage(error),
                });
            });
        }
    }
}
//# sourceMappingURL=opencode-llm.js.map