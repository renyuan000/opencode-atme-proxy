import type { Logger } from "./logger.js";
import { createLogger } from "./logger.js";
import type { OpenCodeBridge } from "./opencode.js";
import type { LlmClient, LlmCompletion, LlmMessage } from "./relevance.js";
import { toErrorMessage } from "./util.js";

export interface OpenCodeLlmOptions {
  bridge: OpenCodeBridge;
  directory: string;
  titlePrefix: string;
  agent?: string;
  model?: { providerID: string; modelID: string };
  timeoutMs?: number;
  logger?: Logger;
}

export class OpenCodeLlmClient implements LlmClient {
  private readonly logger: Logger;
  private resolvedModel?: { providerID: string; modelID: string };

  constructor(private readonly options: OpenCodeLlmOptions) {
    this.logger = options.logger ?? createLogger({ scope: "opencode-llm" });
  }

  async complete(messages: LlmMessage[], signal?: AbortSignal): Promise<LlmCompletion> {
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
    const onAbort = (): void => controller.abort(signal?.reason);
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
    } catch (error) {
      const wrapped = new Error(`filter ${modelLabel}: ${toErrorMessage(error)}`);
      Object.assign(wrapped, {
        kind: (error as { kind?: unknown })?.kind ?? "model_error",
        model: modelLabel,
        timeoutMs: (error as { timeoutMs?: unknown })?.timeoutMs,
      });
      throw wrapped;
    } finally {
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

  private async resolveModel(): Promise<{ providerID: string; modelID: string } | undefined> {
    if (this.resolvedModel) return this.resolvedModel;
    try {
      const client = this.options.bridge.getClient() as unknown as {
        session?: {
          list(input?: Record<string, unknown>): Promise<any>;
        };
      };
      const result = await client.session?.list();
      const sessions = Array.isArray(result?.data) ? result.data : Array.isArray(result) ? result : [];
      const candidates = sessions
        .filter((session: any) => session.model?.providerID && session.model.id)
        .filter((session: any) => !String(session.title ?? "").includes(":filter:"))
        .sort((a: any, b: any) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
      const directSessions = candidates.filter(
        (session: any) => !String(session.title ?? "").startsWith("atme:"),
      );
      const model = (directSessions[0] ?? candidates[0])?.model;
      if (model?.providerID && model.id) {
        this.resolvedModel = { providerID: model.providerID, modelID: model.id };
        this.logger.info("filter model resolved", this.resolvedModel);
      } else {
        this.logger.warn("filter model unresolved; using OpenCode default");
      }
    } catch (error) {
      this.logger.debug("failed to resolve filter model", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return this.resolvedModel;
  }
}
