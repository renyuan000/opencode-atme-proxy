import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { Logger } from "./logger.js";
import { createLogger } from "./logger.js";
import type { RepoConfig } from "./config.js";
import { toErrorMessage } from "./util.js";

export interface SessionCreateInput {
  directory: string;
  title: string;
  agent?: string;
  model?: { providerID: string; modelID: string };
  permission?: Array<{ permission: string; pattern: string; action: "allow" | "deny" | "ask" }>;
}

export interface SessionPromptInput extends SessionCreateInput {
  text: string;
  signal?: AbortSignal;
}

export interface OpenCodeBridge {
  createSession(input: SessionCreateInput): Promise<string>;
  prompt(sessionId: string, input: SessionPromptInput): Promise<string>;
  deleteSession(sessionId: string): Promise<void>;
  getClient(): OpencodeClient;
  getInfo?(): { baseUrl: string; mode: "http" | "injected" };
}

export class HttpOpenCodeBridge implements OpenCodeBridge {
  private readonly logger: Logger;
  private readonly client: OpencodeClient;

  constructor(
    private readonly options: {
      baseUrl: string;
      password?: string;
      logger?: Logger;
    },
  ) {
    this.logger = options.logger ?? createLogger({ scope: "opencode" });
    const auth =
      options.password
        ? `Basic ${Buffer.from(`opencode:${options.password}`).toString("base64")}`
        : undefined;
    this.client = createOpencodeClient({
      baseUrl: options.baseUrl,
      ...(auth
        ? {
            fetch: ((input: string | URL | Request, init?: RequestInit) => {
              const headers = new Headers(init?.headers);
              headers.set("authorization", auth);
              return fetch(input, { ...init, headers });
            }) as typeof fetch,
          }
        : {}),
    }) as unknown as OpencodeClient;
  }

  getClient(): OpencodeClient {
    return this.client;
  }

  getInfo(): { baseUrl: string; mode: "http" | "injected" } {
    return { baseUrl: this.options.baseUrl, mode: "http" };
  }

  async createSession(input: SessionCreateInput): Promise<string> {
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

  async prompt(sessionId: string, input: SessionPromptInput): Promise<string> {
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
      .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (!text) throw new Error("OpenCode returned no text");
    return text;
  }

  async deleteSession(sessionId: string): Promise<void> {
    try {
      await this.client.session.delete({ sessionID: sessionId });
    } catch (error) {
      this.logger.warn("failed to delete OpenCode session", {
        sessionId,
        error: toErrorMessage(error),
      });
    }
  }
}

export class InjectedOpenCodeBridge implements OpenCodeBridge {
  private readonly logger: Logger;

  constructor(private readonly client: OpencodeClient, logger?: Logger) {
    this.logger = logger ?? createLogger({ scope: "opencode" });
  }

  getInfo(): { baseUrl: string; mode: "http" | "injected" } {
    return { baseUrl: "injected", mode: "injected" };
  }

  getClient(): OpencodeClient {
    return this.client;
  }

  async createSession(input: SessionCreateInput): Promise<string> {
    const result = await this.client.session.create({
      title: input.title,
      directory: input.directory,
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

  async prompt(sessionId: string, input: SessionPromptInput): Promise<string> {
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
      .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (!text) throw new Error("OpenCode returned no text");
    return text;
  }

  async deleteSession(sessionId: string): Promise<void> {
    try {
      await this.client.session.delete({ sessionID: sessionId });
    } catch (error) {
      this.logger.warn("failed to delete OpenCode session", {
        sessionId,
        error: toErrorMessage(error),
      });
    }
  }
}

export interface ExecutorOptions {
  bridge: OpenCodeBridge;
  repo: RepoConfig;
  worktreeRoot: string;
  timeoutMs: number;
  logger?: Logger;
}

export interface ExecutionResult {
  success: boolean;
  diffStat: string;
  testSummary: string;
  branch: string;
  worktree: string;
  error?: string;
}

export function repoById(repos: RepoConfig[], id: string): RepoConfig | undefined {
  return repos.find((repo) => repo.id === id);
}

function formatError(error: unknown): string {
  if (!error) return "unknown error";
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
