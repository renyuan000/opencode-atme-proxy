import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { createLogger } from "./logger.js";
import { toErrorMessage } from "./util.js";
export class HttpOpenCodeBridge {
    options;
    logger;
    client;
    constructor(options) {
        this.options = options;
        this.logger = options.logger ?? createLogger({ scope: "opencode" });
        const auth = options.password
            ? `Basic ${Buffer.from(`opencode:${options.password}`).toString("base64")}`
            : undefined;
        this.client = createOpencodeClient({
            baseUrl: options.baseUrl,
            ...(auth
                ? {
                    fetch: ((input, init) => {
                        const headers = new Headers(init?.headers);
                        headers.set("authorization", auth);
                        return fetch(input, { ...init, headers });
                    }),
                }
                : {}),
        });
    }
    getClient() {
        return this.client;
    }
    getInfo() {
        return { baseUrl: this.options.baseUrl, mode: "http" };
    }
    async createSession(input) {
        const result = await this.client.session.create({
            title: input.title,
            directory: input.directory,
            ...(input.agent ? { agent: input.agent } : {}),
            ...(input.model
                ? { model: { id: input.model.modelID, providerID: input.model.providerID } }
                : {}),
            ...(input.permission ? { permission: input.permission } : {}),
        });
        if (result.error || !result.data) {
            throw new Error(`createSession failed: ${formatError(result.error)}`);
        }
        return result.data.id;
    }
    async prompt(sessionId, input) {
        const result = await this.client.session.prompt({
            sessionID: sessionId,
            directory: input.directory,
            ...(input.agent ? { agent: input.agent } : {}),
            ...(input.model
                ? { model: { providerID: input.model.providerID, modelID: input.model.modelID } }
                : {}),
            parts: [{ type: "text", text: input.text }],
        }, input.signal ? { signal: input.signal } : undefined);
        if (result.error || !result.data) {
            throw new Error(`prompt failed: ${formatError(result.error)}`);
        }
        const parts = result.data.parts ?? [];
        const text = parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
            .trim();
        if (!text)
            throw new Error("OpenCode returned no text");
        return text;
    }
    async getSession(sessionId, directory) {
        const result = await this.client.session.get({
            sessionID: sessionId,
            ...(directory ? { directory } : {}),
        });
        if (result.error || !result.data)
            return undefined;
        return toSessionInfo(result.data);
    }
    async archiveSession(sessionId, directory) {
        await this.client.session.update({
            sessionID: sessionId,
            ...(directory ? { directory } : {}),
            time: { archived: Date.now() },
        });
    }
    async listChildren(sessionId, directory) {
        const result = await this.client.session.children({
            sessionID: sessionId,
            ...(directory ? { directory } : {}),
        });
        if (result.error || !result.data)
            return [];
        return result.data.map(toSessionInfo);
    }
    async deleteSession(sessionId) {
        try {
            await this.client.session.delete({ sessionID: sessionId });
        }
        catch (error) {
            this.logger.warn("failed to delete OpenCode session", {
                sessionId,
                error: toErrorMessage(error),
            });
        }
    }
}
export class InjectedOpenCodeBridge {
    client;
    logger;
    constructor(client, logger) {
        this.client = client;
        this.logger = logger ?? createLogger({ scope: "opencode" });
    }
    getInfo() {
        return { baseUrl: "injected", mode: "injected" };
    }
    getClient() {
        return this.client;
    }
    async createSession(input) {
        const result = await this.client.session.create({
            title: input.title,
            directory: input.directory,
            ...(input.agent ? { agent: input.agent } : {}),
            ...(input.parentID ? { parentID: input.parentID } : {}),
            ...(input.model
                ? { model: { id: input.model.modelID, providerID: input.model.providerID } }
                : {}),
            ...(input.permission ? { permission: input.permission } : {}),
        });
        if (result.error || !result.data) {
            throw new Error(`createSession failed: ${formatError(result.error)}`);
        }
        return result.data.id;
    }
    async prompt(sessionId, input) {
        const result = await this.client.session.prompt({
            sessionID: sessionId,
            directory: input.directory,
            ...(input.model
                ? { model: { providerID: input.model.providerID, modelID: input.model.modelID } }
                : {}),
            parts: [{ type: "text", text: input.text }],
        }, input.signal ? { signal: input.signal } : undefined);
        if (result.error || !result.data) {
            throw new Error(`prompt failed: ${formatError(result.error)}`);
        }
        const text = (result.data.parts ?? [])
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
            .trim();
        if (!text)
            throw new Error("OpenCode returned no text");
        return text;
    }
    async getSession(sessionId, directory) {
        const result = await this.client.session.get({
            sessionID: sessionId,
            ...(directory ? { directory } : {}),
        });
        if (result.error || !result.data)
            return undefined;
        return toSessionInfo(result.data);
    }
    async archiveSession(sessionId, directory) {
        await this.client.session.update({
            sessionID: sessionId,
            ...(directory ? { directory } : {}),
            time: { archived: Date.now() },
        });
    }
    async listChildren(sessionId, directory) {
        const result = await this.client.session.children({
            sessionID: sessionId,
            ...(directory ? { directory } : {}),
        });
        if (result.error || !result.data)
            return [];
        return result.data.map(toSessionInfo);
    }
    async deleteSession(sessionId) {
        try {
            await this.client.session.delete({ sessionID: sessionId });
        }
        catch (error) {
            this.logger.warn("failed to delete OpenCode session", {
                sessionId,
                error: toErrorMessage(error),
            });
        }
    }
}
export function repoById(repos, id) {
    return repos.find((repo) => repo.id === id);
}
function toSessionInfo(session) {
    return {
        id: session.id,
        title: session.title,
        directory: session.directory,
        ...(session.parentID ? { parentID: session.parentID } : {}),
        ...(session.time?.archived ? { timeArchived: session.time.archived } : {}),
    };
}
function formatError(error) {
    if (!error)
        return "unknown error";
    if (error instanceof Error)
        return error.message;
    if (typeof error === "string")
        return error;
    try {
        return JSON.stringify(error);
    }
    catch {
        return String(error);
    }
}
//# sourceMappingURL=opencode.js.map