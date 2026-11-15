import * as Lark from "@larksuiteoapi/node-sdk";
import { createLogger } from "../../core/logger.js";
import { toErrorMessage } from "../../core/util.js";
import { parseCardAction } from "./adapter.js";
const silentLogger = {
    error: () => { },
    warn: () => { },
    info: () => { },
    debug: () => { },
    trace: () => { },
};
export class FeishuEventSource {
    options;
    logger;
    wsClient;
    handlers;
    started = false;
    constructor(options) {
        this.options = options;
        this.logger = options.logger ?? createLogger({ scope: "feishu.events" });
    }
    async start(handlers) {
        if (this.started)
            return;
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
            onError: (error) => this.logger.error("websocket error", { error: toErrorMessage(error) }),
            onReconnecting: () => this.logger.warn("websocket reconnecting"),
            onReconnected: () => this.logger.info("websocket reconnected"),
        });
        const dispatcher = new Lark.EventDispatcher({}).register({
            "im.message.receive_v1": async (data) => {
                if (!this.handlers)
                    return { ok: true };
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
            "card.action.trigger": async (raw) => {
                if (!this.handlers)
                    return { ok: true };
                const action = parseCardAction(raw);
                if (!action)
                    return { toast: { type: "error", content: "无效操作" } };
                const result = await this.handlers.onAction(action);
                return toCardResponse(result);
            },
            "im.chat.access_event.bot_p2p_chat_entered_v1": async () => ({ ok: true }),
            "im.message.message_read_v1": async () => ({ ok: true }),
        });
        await this.wsClient.start({ eventDispatcher: dispatcher });
        this.started = true;
        this.logger.info("event source started");
    }
    async stop() {
        this.handlers = undefined;
        if (this.wsClient) {
            this.wsClient.close({ force: true });
            this.wsClient = undefined;
        }
        this.started = false;
    }
    async handleAction(action) {
        if (!this.handlers)
            return { ok: false, toast: "服务未启动" };
        return this.handlers.onAction(action);
    }
}
function toCardResponse(result) {
    return {
        toast: {
            type: result.ok ? "success" : "error",
            content: result.toast ?? (result.ok ? "已处理" : "处理失败"),
        },
    };
}
//# sourceMappingURL=events.js.map