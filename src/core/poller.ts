import type { IncomingMessage } from "./types.js";
import type { PlatformAdapter } from "./ports.js";
import type { CursorStore } from "./cursor.js";
import type { Logger } from "./logger.js";
import { createLogger } from "./logger.js";
import { toErrorMessage } from "./util.js";

export interface PollingOptions {
  enabled: boolean;
  platform: PlatformAdapter;
  cursors: CursorStore;
  groups: Array<{ chatId: string; name?: string; enabled: boolean }>;
  intervalMs: number;
  overlapMs: number;
  lookbackMs: number;
  pageSize: number;
  maxPages: number;
  maxMessagesPerRun: number;
  onBatch(messages: IncomingMessage[]): Promise<void>;
  logger?: Logger;
}

export class PollingService {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly logger: Logger;
  private readonly enabledGroups: Array<{ chatId: string; name?: string }>;

  constructor(private readonly options: PollingOptions) {
    this.logger = options.logger ?? createLogger({ scope: "poller" });
    this.enabledGroups = options.groups
      .filter((group) => group.enabled)
      .map((group) => ({ chatId: group.chatId, ...(group.name ? { name: group.name } : {}) }));
  }

  start(): void {
    if (this.timer) return;
    if (!this.options.enabled) {
      this.logger.info("polling disabled by config");
      return;
    }
    if (!this.options.platform.capabilities().groupHistory) {
      this.logger.warn("platform has no groupHistory capability; polling disabled");
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.intervalMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.running) {
      this.logger.warn("polling tick skipped: previous tick still running");
      return;
    }
    this.running = true;
    try {
      for (const group of this.enabledGroups) {
        await this.pollGroup(group.chatId, group.name);
      }
    } finally {
      this.running = false;
    }
  }

  private async pollGroup(chatId: string, name?: string): Promise<void> {
    const endTime = Date.now();
    const cursor = this.options.cursors.get(chatId);
    const startTime =
      cursor !== undefined
        ? Math.max(0, cursor - this.options.overlapMs)
        : endTime - this.options.lookbackMs;
    if (startTime >= endTime) return;
    try {
      const result = await this.options.platform.listMessages({
        chatId,
        startTime,
        endTime,
        maxPages: this.options.maxPages,
        maxMessages: this.options.maxMessagesPerRun,
      });
      if (result.messages.length > 0) {
        await this.options.onBatch(result.messages);
      }
      const last = result.messages.reduce<IncomingMessage | undefined>(
        (latest, message) =>
          !latest || message.createdAt >= latest.createdAt ? message : latest,
        undefined,
      );
      this.options.cursors.set(chatId, endTime, {
        ...(last ? { messageId: last.messageId, messageTime: last.createdAt } : {}),
      });
      await this.options.cursors.flush();
      if (result.messages.length > 0) {
        this.logger.info("poll completed", {
          chatId,
          name,
          messages: result.messages.length,
          lastMessageId: last?.messageId,
          lastMessageTime: last?.createdAt,
          windowMs: endTime - startTime,
        });
      } else {
        this.logger.debug("poll idle", { chatId, name, windowMs: endTime - startTime });
      }
    } catch (error) {
      const data = (error as { response?: { data?: { code?: number; msg?: string } } })
        .response?.data;
      this.logger.error("poll failed; cursor not advanced", {
        chatId,
        name,
        ...(data?.code !== undefined ? { code: data.code } : {}),
        ...(data?.msg ? { detail: data.msg } : {}),
        error: toErrorMessage(error),
      });
    }
  }
}
