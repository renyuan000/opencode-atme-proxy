import { formatLocalTime, toErrorMessage, truncate } from "./util.js";
export class ScanService {
    options;
    constructor(options) {
        this.options = options;
    }
    async handlePolledBatch(messages) {
        let failed = false;
        const candidates = messages.filter((message) => {
            if (message.senderType !== "user")
                return false;
            if (message.chat.kind !== "group")
                return false;
            if (this.options.config.policy.defaultDenyGroups) {
                if (!this.options.groupIds.has(message.chat.id))
                    return false;
            }
            return true;
        });
        if (candidates.length === 0)
            return;
        for (const message of candidates) {
            if (!this.options.isMention(message))
                continue;
            try {
                await this.options.onMessage(message, true);
            }
            catch (error) {
                failed = true;
                this.options.logger.error("polled mention handling failed", {
                    messageId: message.messageId,
                    error: toErrorMessage(error),
                });
            }
        }
        const plain = candidates.filter((message) => !this.options.isMention(message));
        if (plain.length === 0)
            return;
        const fresh = plain.filter((message) => {
            const key = `${message.platform}:${message.messageId}`;
            return !this.options.dedup.has(key) && !this.options.activeMessageIds.has(key);
        });
        if (fresh.length === 0)
            return;
        const perSender = new Map();
        const capped = fresh.filter((message) => {
            const count = (perSender.get(message.sender.id) ?? 0) + 1;
            if (count > this.options.config.botReply.maxMessagesPerSenderPerRun)
                return false;
            perSender.set(message.sender.id, count);
            return true;
        });
        if (capped.length < fresh.length) {
            this.options.logger.warn("per-sender message cap applied", {
                dropped: fresh.length - capped.length,
            });
        }
        for (const message of capped) {
            this.options.activeMessageIds.add(`${message.platform}:${message.messageId}`);
        }
        const chatId = capped[0]?.chat.id ?? "unknown";
        const budget = this.options.config.budget.maxMessagesPerRun;
        const limitedMessages = capped.slice(0, budget);
        if (limitedMessages.length < capped.length) {
            await this.options.sendToApprover(`本轮消息超过预算，仅处理 ${limitedMessages.length}/${capped.length} 条；剩余留待下一轮。`);
            failed = true;
        }
        try {
            await this.options.dispatcher.enqueue({
                id: `scan:${chatId}:${limitedMessages[0]?.messageId ?? Date.now()}`,
                key: `${chatId}:scan`,
                keyConcurrency: this.options.config.concurrency.scanConcurrency,
                priority: 5,
                timeoutMs: this.options.config.concurrency.scanTimeoutMs,
                run: async (signal) => {
                    try {
                        await this.handlePolledBatchJob(limitedMessages, signal);
                    }
                    finally {
                        for (const message of capped) {
                            this.options.activeMessageIds.delete(`${message.platform}:${message.messageId}`);
                        }
                    }
                },
            });
        }
        catch (error) {
            for (const message of capped) {
                this.options.activeMessageIds.delete(`${message.platform}:${message.messageId}`);
            }
            this.options.logger.error("polled batch failed", {
                chatId,
                count: capped.length,
                error: toErrorMessage(error),
            });
            throw error;
        }
        if (failed) {
            throw new Error("polled batch had failed messages; cursor not advanced");
        }
    }
    async handleGroupScan(message, signal) {
        const classification = await this.options.intentService.classifyOne(message, signal);
        if (!classification?.relevant)
            return;
        let handled = false;
        if (classification.actionability === "task" &&
            classification.confidence >= this.options.config.filter.minTaskConfidence) {
            const task = await this.options.taskService.ensureTask(message, classification, "group_scan");
            if (task)
                handled = true;
        }
        else {
            handled = await this.options.sendToApprover([
                "群消息可能与你相关",
                `群：${message.chat.name ?? message.chat.id}`,
                `发送人：${message.sender.displayName ?? message.sender.id}`,
                `内容：${truncate(message.text, 200)}`,
                `判断：${classification.reason}`,
                `建议：${suggestedActionLabel(classification.actionability)}`,
            ].join("\n"));
        }
        if (handled)
            await this.options.markProcessed(message);
    }
    async handlePolledBatchJob(messages, signal) {
        if (!this.options.filterEnabled) {
            await this.digestWithoutFilter(messages);
            return;
        }
        const { items, stats } = await this.options.relevance().classify(messages, signal);
        if (stats.totalTokens > this.options.config.budget.maxTokensPerRun) {
            await this.options.sendToApprover(`本轮筛选 token 超预算：${stats.totalTokens}/${this.options.config.budget.maxTokensPerRun}，已停止后续批次。`);
        }
        if (stats.failures > 0) {
            const failed = stats.failedMessageIds;
            await this.options.sendToApprover(`筛选失败：${failed.length} 条消息未处理，已保留待重试。\n原因见日志；不会静默丢弃。`);
        }
        const byId = new Map(items.map((item) => [item.messageId, item]));
        const failed = new Set(stats.failedMessageIds);
        for (const message of messages) {
            if (failed.has(message.messageId))
                continue;
            const item = byId.get(message.messageId);
            if (!item?.relevant) {
                await this.options.markProcessed(message);
                continue;
            }
            this.appendContextForScan(message);
            if (item.actionability === "task" &&
                item.confidence >= this.options.config.filter.minTaskConfidence) {
                await this.options.taskService.ensureTask(message, item, "group_scan");
            }
            await this.options.markProcessed(message);
        }
        await this.sendOwnerDigest(messages, items);
        this.options.logger.info("polled batch classified", {
            chatId: messages[0]?.chat.id,
            messages: stats.messages,
            batches: stats.batches,
            tokens: stats.totalTokens,
            relevant: items.filter((item) => item.relevant).length,
        });
    }
    async digestWithoutFilter(messages) {
        const usable = messages.filter((message) => message.senderType === "user" && message.text.trim().length > 0);
        if (usable.length === 0) {
            for (const message of messages)
                await this.options.markProcessed(message);
            return;
        }
        await this.sendOwnerDigest(usable, []);
        for (const message of messages)
            await this.options.markProcessed(message);
    }
    async sendOwnerDigest(messages, items) {
        const byId = new Map(items.map((item) => [item.messageId, item]));
        const lines = [];
        const related = [];
        for (const message of messages) {
            const item = byId.get(message.messageId);
            if (item?.relevant)
                related.push(message);
        }
        const highlighted = related.length > 0 ? related : messages.slice(0, 5);
        for (const message of highlighted.slice(0, 8)) {
            const item = byId.get(message.messageId);
            const sender = message.sender.displayName ?? message.sender.id;
            const time = formatLocalTime(message.createdAt);
            const reason = item?.reason ? `｜判断：${truncate(item.reason, 80)}` : "";
            const action = item?.actionability ? `｜类型：${item.actionability}` : "";
            lines.push([
                `• ${time} ${sender}${action}${reason}`,
                `  ${truncate(message.text.replace(/\s+/g, " "), 160)}`,
                `  message_id: ${message.messageId}`,
            ].join("\n"));
        }
        const summary = related.length > 0
            ? `与你相关 ${related.length} 条，共 ${messages.length} 条`
            : `本轮 ${messages.length} 条，未识别出强相关；下面是最近的`;
        await this.options.sendToOwner([`群消息分析：${summary}`, ...lines].join("\n\n"));
    }
    appendContextForScan(message) {
        if (!this.options.config.context.enabled)
            return;
        if (!this.options.config.context.storeRelevantScan)
            return;
        this.options.chatContext.append(`${message.platform}:${message.chat.id}`, {
            messageId: message.messageId,
            senderId: message.sender.id,
            ...(message.sender.displayName ? { senderName: message.sender.displayName } : {}),
            text: message.text,
            at: message.createdAt,
            ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
            ...(message.threadId ? { threadId: message.threadId } : {}),
            mentionMe: false,
            mentionBot: false,
            origin: "scan_relevant",
        }, {
            platform: message.platform,
            chatId: message.chat.id,
            ...(message.chat.name ? { chatName: message.chat.name } : {}),
        });
    }
}
function suggestedActionLabel(actionability) {
    switch (actionability) {
        case "task":
            return "转任务";
        case "question":
            return "可代答";
        case "fyi":
            return "仅知会";
        default:
            return "忽略";
    }
}
//# sourceMappingURL=scan-service.js.map