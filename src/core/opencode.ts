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
  parentID?: string;
  model?: { providerID: string; modelID: string };
  permission?: Array<{ permission: string; pattern: string; action: "allow" | "deny" | "ask" }>;
}

export interface SessionInfo {
  id: string;
  title: string;
  directory: string;
  parentID?: string;
  timeArchived?: number;
}

export interface SessionPromptInput extends SessionCreateInput {
  text: string;
  attachments?: PromptAttachment[];
  signal?: AbortSignal;
}

export interface PromptAttachment {
  mime: string;
  url: string;
  filename?: string;
}

export interface OpenCodeBridge {
  createSession(input: SessionCreateInput): Promise<string>;
  prompt(sessionId: string, input: SessionPromptInput): Promise<string>;
  deleteSession(sessionId: string): Promise<void>;
  getClient(): OpencodeClient;
  getInfo?(): { baseUrl: string; mode: "http" | "injected" };
  healthCheck?(): Promise<{ ok: boolean; detail?: string }>;
  getSession?(sessionId: string, directory?: string): Promise<SessionInfo | undefined>;
  archiveSession?(sessionId: string, directory?: string): Promise<void>;
  listChildren?(sessionId: string, directory?: string): Promise<SessionInfo[]>;
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

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const result = await this.client.provider.list({});
      if (result.error || !result.data) {
        return { ok: false, detail: formatError(result.error) };
      }
      const connected = result.data.connected ?? [];
      return {
        ok: true,
        detail:
          connected.length > 0
            ? `providers: ${connected.join(", ")}`
            : "providers: none connected",
      };
    } catch (error) {
      return { ok: false, detail: toErrorMessage(error) };
    }
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
      parts: [
        { type: "text", text: input.text },
        ...(input.attachments ?? []).map((attachment) => ({
          type: "file" as const,
          mime: attachment.mime,
          url: attachment.url,
          ...(attachment.filename ? { filename: attachment.filename } : {}),
        })),
      ],
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

  async getSession(sessionId: string, directory?: string): Promise<SessionInfo | undefined> {
    const result = await this.client.session.get({
      sessionID: sessionId,
      ...(directory ? { directory } : {}),
    });
    if (result.error || !result.data) return undefined;
    return toSessionInfo(result.data);
  }

  async archiveSession(sessionId: string, directory?: string): Promise<void> {
    await this.client.session.update({
      sessionID: sessionId,
      ...(directory ? { directory } : {}),
      time: { archived: Date.now() },
    });
  }

  async listChildren(sessionId: string, directory?: string): Promise<SessionInfo[]> {
    const result = await this.client.session.children({
      sessionID: sessionId,
      ...(directory ? { directory } : {}),
    });
    if (result.error || !result.data) return [];
    return result.data.map(toSessionInfo);
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

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: "injected bridge" };
  }

  getClient(): OpencodeClient {
    return this.client;
  }

  async createSession(input: SessionCreateInput): Promise<string> {
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

  async prompt(sessionId: string, input: SessionPromptInput): Promise<string> {
    const result = await this.client.session.prompt({
      sessionID: sessionId,
      directory: input.directory,
      ...(input.model
        ? { model: { providerID: input.model.providerID, modelID: input.model.modelID } }
        : {}),
      parts: [
        { type: "text", text: input.text },
        ...(input.attachments ?? []).map((attachment) => ({
          type: "file" as const,
          mime: attachment.mime,
          url: attachment.url,
          ...(attachment.filename ? { filename: attachment.filename } : {}),
        })),
      ],
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

  async getSession(sessionId: string, directory?: string): Promise<SessionInfo | undefined> {
    const result = await this.client.session.get({
      sessionID: sessionId,
      ...(directory ? { directory } : {}),
    });
    if (result.error || !result.data) return undefined;
    return toSessionInfo(result.data);
  }

  async archiveSession(sessionId: string, directory?: string): Promise<void> {
    await this.client.session.update({
      sessionID: sessionId,
      ...(directory ? { directory } : {}),
      time: { archived: Date.now() },
    });
  }

  async listChildren(sessionId: string, directory?: string): Promise<SessionInfo[]> {
    const result = await this.client.session.children({
      sessionID: sessionId,
      ...(directory ? { directory } : {}),
    });
    if (result.error || !result.data) return [];
    return result.data.map(toSessionInfo);
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


function toSessionInfo(session: {
  id: string;
  title: string;
  directory: string;
  parentID?: string;
  time?: { archived?: number };
}): SessionInfo {
  return {
    id: session.id,
    title: session.title,
    directory: session.directory,
    ...(session.parentID ? { parentID: session.parentID } : {}),
    ...(session.time?.archived ? { timeArchived: session.time.archived } : {}),
  };
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
