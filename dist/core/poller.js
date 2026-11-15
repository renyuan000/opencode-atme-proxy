import { createLogger } from "./logger.js";
import { toErrorMessage } from "./util.js";
export class PollingService {
    options;
    timer;
    running = false;
    logger;
    enabledGroups;
    constructor(options) {
        this.options = options;
        this.logger = options.logger ?? createLogger({ scope: "poller" });
        this.enabledGroups = options.groups
            .filter((group) => group.enabled)
            .map((group) => ({ chatId: group.chatId, ...(group.name ? { name: group.name } : {}) }));
    }
    start() {
        if (this.timer)
            return;
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
    stop() {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = undefined;
    }
    async tick() {
        if (this.running) {
            this.logger.warn("polling tick skipped: previous tick still running");
            return;
        }
        this.running = true;
        try {
            for (const group of this.enabledGroups) {
                await this.pollGroup(group.chatId, group.name);
            }
        }
        finally {
            this.running = false;
        }
    }
    async pollGroup(chatId, name) {
        const endTime = Date.now();
        const cursor = this.options.cursors.get(chatId);
        const startTime = cursor !== undefined
            ? Math.max(0, cursor - this.options.overlapMs)
            : endTime - this.options.lookbackMs;
        if (startTime >= endTime)
            return;
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
            const last = result.messages.reduce((latest, message) => !latest || message.createdAt >= latest.createdAt ? message : latest, undefined);
            this.options.cursors.set(chatId, endTime, {
                ...(last ? { messageId: last.messageId, messageTime: last.createdAt } : {}),
            });
            await this.options.cursors.flush();
            this.logger.info("poll completed", {
                chatId,
                name,
                messages: result.messages.length,
                lastMessageId: last?.messageId,
                lastMessageTime: last?.createdAt,
                windowMs: endTime - startTime,
            });
        }
        catch (error) {
            this.logger.error("poll failed; cursor not advanced", {
                chatId,
                name,
                error: toErrorMessage(error),
            });
        }
    }
}
//# sourceMappingURL=poller.js.map