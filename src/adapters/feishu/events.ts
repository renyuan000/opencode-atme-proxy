import * as Lark from "@larksuiteoapi/node-sdk";
import type { FeishuConfig } from "../../core/config.js";
import type { Logger } from "../../core/logger.js";
import { createLogger } from "../../core/logger.js";
import type { PlatformAction, PlatformActionResult } from "../../core/types.js";
import { redactPreview, toErrorMessage } from "../../core/util.js";
import type { FeishuAdapter } from "./adapter.js";
import { parseCardAction } from "./adapter.js";
import type { AdapterHandlers } from "../../core/ports.js";

export interface FeishuEventSourceOptions {
  config: FeishuConfig;
  appSecret: string;
  adapter: FeishuAdapter;
  logger?: Logger;
}

const silentLogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
};

export class FeishuEventSource {
  private readonly logger: Logger;
  private wsClient?: Lark.WSClient;
  private handlers?: AdapterHandlers;
  private started = false;

  constructor(private readonly options: FeishuEventSourceOptions) {
    this.logger = options.logger ?? createLogger({ scope: "feishu.events" });
  }

  async start(handlers: AdapterHandlers): Promise<void> {
    if (this.started) return;
    this.handlers = handlers;
    const { config, appSecret } = this.options;
    this.wsClient = new Lark.WSClient({
      appId: config.appId,
      appSecret,
      domain: config.domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu,
      logger: silentLogger,
      autoReconnect: true,
      handshakeTimeoutMs: 10_000,
      wsConfig: { pingTimeout: 10 },
      onReady: () => this.logger.info("websocket ready"),
      onError: (error: Error) => this.logger.error("websocket error", { error: toErrorMessage(error) }),
      onReconnecting: () => this.logger.warn("websocket reconnecting"),
      onReconnected: () => this.logger.info("websocket reconnected"),
    });

    const dispatcher = new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data: any) => {
        if (!this.handlers) return { ok: true };
        const raw = {
          ...data.message,
          sender: data.sender,
        };
        const { mapFeishuMessage } = await import("./adapter.js");
        const message = mapFeishuMessage(raw);
        if (message) {
          this.logger.info("inbound message", {
            messageId: message.messageId,
            chatId: message.chat.id,
            mentions: message.mentions.length,
            type: message.rawType,
            textPreview: redactPreview(message.text),
          });
          void this.handlers.onMessage(message).catch((error) => {
            this.logger.error("message handler failed", {
              messageId: message.messageId,
              error: toErrorMessage(error),
            });
          });
        }
        return { ok: true };
      },
      "card.action.trigger": async (raw: any) => {
        if (!this.handlers) return { ok: true };
        const action = parseCardAction(raw);
        if (!action) return { toast: { type: "error", content: "无效操作" } };
        const result = await this.handlers.onAction(action);
        return toCardResponse(result);
      },
      "im.chat.member.bot.added_v1": async (data: any) => {
        const chatId = data?.chat_id;
        if (chatId && this.handlers?.onChatMembership) {
          this.logger.info("bot added to chat", { chatId, operator: data?.operator_id?.open_id });
          void this.handlers
            .onChatMembership({
              platform: "feishu",
              chatId,
              change: "bot_added",
              ...(data?.operator_id?.open_id ? { actorId: data.operator_id.open_id } : {}),
              at: Number(data?.create_time ?? Date.now()),
            })
            .catch((error) =>
              this.logger.error("chat membership handler failed", {
                chatId,
                error: toErrorMessage(error),
              }),
            );
        }
        return { ok: true };
      },
      "im.chat.member.bot.deleted_v1": async (data: any) => {
        const chatId = data?.chat_id;
        if (chatId && this.handlers?.onChatMembership) {
          this.logger.info("bot removed from chat", { chatId, operator: data?.operator_id?.open_id });
          void this.handlers
            .onChatMembership({
              platform: "feishu",
              chatId,
              change: "bot_removed",
              ...(data?.operator_id?.open_id ? { actorId: data.operator_id.open_id } : {}),
              at: Number(data?.create_time ?? Date.now()),
            })
            .catch((error) =>
              this.logger.error("chat membership handler failed", {
                chatId,
                error: toErrorMessage(error),
              }),
            );
        }
        return { ok: true };
      },
      "im.chat.access_event.bot_p2p_chat_entered_v1": async () => ({ ok: true }),
      "im.message.message_read_v1": async () => ({ ok: true }),
      "im.message.recalled_v1": async (data: any) => {
        if (!this.handlers?.onMessageRecalled) return { ok: true };
        const event = data?.event ?? data;
        const messageId = event?.message_id ?? data?.message_id;
        if (!messageId) return { ok: true };
        await this.handlers.onMessageRecalled({
          platform: "feishu",
          messageId,
          ...(event?.chat_id ? { chatId: event.chat_id } : {}),
          at: Number(event?.action_time ?? Date.now()),
        }).catch((error) =>
          this.logger.warn("message recall handler failed", {
            messageId,
            error: toErrorMessage(error),
          }),
        );
        return { ok: true };
      },
    });

    await this.wsClient.start({ eventDispatcher: dispatcher });
    this.started = true;
    this.logger.info("event source started");
  }

  async stop(): Promise<void> {
    this.handlers = undefined;
    if (this.wsClient) {
      this.wsClient.close({ force: true });
      this.wsClient = undefined;
    }
    this.started = false;
  }

  async handleAction(action: PlatformAction): Promise<PlatformActionResult> {
    if (!this.handlers) return { ok: false, toast: "服务未启动" };
    return this.handlers.onAction(action);
  }
}

function toCardResponse(result: PlatformActionResult): Record<string, unknown> {
  return {
    toast: {
      type: result.ok ? "success" : "error",
      content: result.toast ?? (result.ok ? "已处理" : "处理失败"),
    },
    ...(result.card ? { card: { type: "raw", data: result.card } } : {}),
  };
}

