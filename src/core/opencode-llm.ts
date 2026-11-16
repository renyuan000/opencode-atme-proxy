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
  logger?: Logger;
}

export class OpenCodeLlmClient implements LlmClient {
  private readonly logger: Logger;

  constructor(private readonly options: OpenCodeLlmOptions) {
    this.logger = options.logger ?? createLogger({ scope: "opencode-llm" });
  }

  async complete(messages: LlmMessage[]): Promise<LlmCompletion> {
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
    try {
      const text = await this.options.bridge.prompt(sessionId, {
        directory: this.options.directory,
        title,
        text: system ? `${system}\n\n${user}` : user,
      });
      return {
        text,
        model: "opencode",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    } finally {
      await this.options.bridge.deleteSession(sessionId).catch((error) => {
        this.logger.warn("failed to delete filter session", {
          sessionId,
          error: toErrorMessage(error),
        });
      });
    }
  }
}
