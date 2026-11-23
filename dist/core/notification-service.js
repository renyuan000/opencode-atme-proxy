import { sha256, stableUuid, toErrorMessage } from "./util.js";
export class NotificationService {
    options;
    constructor(options) {
        this.options = options;
    }
    async sendToOwner(text, sourceMessageId) {
        const openId = this.options.ownerOpenId();
        if (!openId)
            return false;
        try {
            await this.options.sendLimiter.take();
            const result = await this.options.platform.send({ kind: "user", userId: openId }, {
                kind: "text",
                text,
                uuid: stableUuid("owner", openId, sha256(text).slice(0, 16)),
            });
            if (sourceMessageId) {
                try {
                    await this.options.sentReplies.add({
                        platform: "feishu",
                        chatId: `user:${openId}`,
                        senderLabel: openId,
                        sourceMessageId,
                        sentMessageId: result.messageId,
                        text,
                        sourceText: "",
                        sentAt: Date.now(),
                    });
                }
                catch (error) {
                    this.options.logger.warn("failed to record owner message", {
                        error: toErrorMessage(error),
                    });
                }
            }
            return true;
        }
        catch (error) {
            this.options.logger.error("failed to send to owner", {
                error: toErrorMessage(error),
            });
            return false;
        }
    }
    sendToApprover(text) {
        return this.sendToOwner(text);
    }
    async forwardToOwner(messageId) {
        const openId = this.options.ownerOpenId();
        if (!openId || !this.options.platform.forwardMessage)
            return false;
        try {
            await this.options.sendLimiter.take();
            await this.options.platform.forwardMessage(messageId, {
                kind: "user",
                userId: openId,
            });
            return true;
        }
        catch (error) {
            this.options.logger.warn("failed to forward message to owner", {
                messageId,
                error: toErrorMessage(error),
            });
            return false;
        }
    }
    async safeReply(message, text) {
        const key = `reply:${message.platform}:${message.messageId}:${sha256(text).slice(0, 12)}`;
        if (this.options.outbound.has(key, message.chat.id)) {
            this.options.logger.info("skip duplicate reply", {
                messageId: message.messageId,
            });
            return true;
        }
        try {
            await this.options.sendLimiter.take();
            const result = await this.options.platform.reply({ chatId: message.chat.id, messageId: message.messageId }, { kind: "text", text, uuid: stableUuid(key) });
            this.options.outbound.add(key, message.chat.id);
            await this.options.outbound.flush();
            try {
                await this.options.sentReplies.add({
                    platform: message.platform,
                    chatId: message.chat.id,
                    ...(message.chat.name ? { chatName: message.chat.name } : {}),
                    senderLabel: message.sender.displayName ?? message.sender.id,
                    sourceMessageId: message.messageId,
                    sentMessageId: result.messageId,
                    text,
                    sourceText: message.text,
                    sentAt: Date.now(),
                });
            }
            catch (error) {
                this.options.logger.warn("failed to record sent reply", {
                    messageId: message.messageId,
                    error: toErrorMessage(error),
                });
            }
            this.options.evidence.append({
                ts: Date.now(),
                platform: message.platform,
                chatId: message.chat.id,
                ...(message.chat.name ? { chatName: message.chat.name } : {}),
                messageId: message.messageId,
                direction: "outbound",
                origin: "reply",
                text,
            });
            return true;
        }
        catch (error) {
            this.options.logger.error("failed to reply", {
                messageId: message.messageId,
                error: toErrorMessage(error),
            });
            return false;
        }
    }
    async chatLabel(message) {
        const chatId = message.chat.id;
        const cached = this.options.chatNames.get(chatId);
        if (cached && Date.now() - cached.at < 6 * 3600_000)
            return cached.name;
        if (message.chat.name) {
            this.rememberChatName(chatId, message.chat.name);
            return message.chat.name;
        }
        const configured = this.options.config.platforms.feishu.groups.find((group) => group.chatId === chatId);
        if (configured?.name && configured.name !== chatId) {
            this.rememberChatName(chatId, configured.name);
            return configured.name;
        }
        const name = await this.fetchChatName(chatId);
        if (name) {
            this.rememberChatName(chatId, name);
            return name;
        }
        return chatId;
    }
    rememberChatName(chatId, name) {
        this.options.chatNames.set(chatId, { name, at: Date.now() });
    }
    async fetchChatName(chatId) {
        const client = this.options.bridge.getClient?.();
        if (!client)
            return undefined;
        try {
            const response = await client.im.v1.chat.get({
                path: { chat_id: chatId },
            });
            if (typeof response?.data?.name === "string" && response.data.name) {
                return response.data.name;
            }
        }
        catch (error) {
            this.options.logger.debug("chat.get failed; trying raw request", {
                chatId,
                error: toErrorMessage(error),
            });
        }
        try {
            const raw = await client.request({
                method: "GET",
                url: `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`,
            });
            if (typeof raw?.data?.name === "string" && raw.data.name)
                return raw.data.name;
        }
        catch (error) {
            this.options.logger.debug("raw chat lookup failed", {
                chatId,
                error: toErrorMessage(error),
            });
        }
        return undefined;
    }
}
//# sourceMappingURL=notification-service.js.map