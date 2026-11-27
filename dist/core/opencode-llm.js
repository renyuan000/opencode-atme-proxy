import { createLogger } from "./logger.js";
import { toErrorMessage } from "./util.js";
export class OpenCodeLlmClient {
    options;
    logger;
    resolvedModel;
    constructor(options) {
        this.options = options;
        this.logger = options.logger ?? createLogger({ scope: "opencode-llm" });
    }
    async complete(messages, signal) {
        const system = messages.find((message) => message.role === "system")?.content ?? "";
        const user = messages.find((message) => message.role === "user")?.content ?? "";
        const title = `${this.options.titlePrefix}:filter:${Date.now()}`;
        const model = this.options.model ?? (await this.resolveModel());
        const modelLabel = model ? `${model.providerID}/${model.modelID}` : "opencode/default";
        const sessionId = await this.options.bridge.createSession({
            directory: this.options.directory,
            title,
            ...(this.options.agent ? { agent: this.options.agent } : {}),
            ...(model ? { model } : {}),
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
        const timer = setTimeout(() => {
            const error = new Error(`筛选模型请求超时（${timeoutMs}ms）`);
            Object.assign(error, { kind: "model_timeout", model: modelLabel, timeoutMs });
            controller.abort(error);
        }, timeoutMs);
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
                model: modelLabel,
                usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            };
        }
        catch (error) {
            const wrapped = new Error(`filter ${modelLabel}: ${toErrorMessage(error)}`);
            Object.assign(wrapped, {
                kind: error?.kind ?? "model_error",
                model: modelLabel,
                timeoutMs: error?.timeoutMs,
            });
            throw wrapped;
        }
        finally {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            await this.deleteFilterSession(sessionId).catch((error) => {
                this.logger.warn("failed to delete filter session", {
                    sessionId,
                    error: toErrorMessage(error),
                });
            });
        }
    }
    async deleteFilterSession(sessionId) {
        let lastError;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            try {
                await this.options.bridge.deleteSession(sessionId);
                return;
            }
            catch (error) {
                lastError = error;
                if (attempt < 3)
                    await new Promise((resolve) => setTimeout(resolve, 100));
            }
        }
        throw lastError;
    }
    async resolveModel() {
        if (this.resolvedModel)
            return this.resolvedModel;
        try {
            const client = this.options.bridge.getClient();
            const result = await client.session?.list();
            const sessions = Array.isArray(result?.data) ? result.data : Array.isArray(result) ? result : [];
            const candidates = sessions
                .filter((session) => session.model?.providerID && session.model.id)
                .filter((session) => !String(session.title ?? "").includes(":filter:"))
                .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
            const directSessions = candidates.filter((session) => !String(session.title ?? "").startsWith("atme:"));
            const model = (directSessions[0] ?? candidates[0])?.model;
            if (model?.providerID && model.id) {
                this.resolvedModel = { providerID: model.providerID, modelID: model.id };
                this.logger.info("filter model resolved", this.resolvedModel);
            }
            else {
                this.logger.warn("filter model unresolved; using OpenCode default");
            }
        }
        catch (error) {
            this.logger.debug("failed to resolve filter model", {
                error: error instanceof Error ? error.message : String(error),
            });
        }
        return this.resolvedModel;
    }
}
//# sourceMappingURL=opencode-llm.js.map