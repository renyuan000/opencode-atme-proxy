import { toErrorMessage } from "./util.js";
export class RecoveryService {
    options;
    constructor(options) {
        this.options = options;
    }
    async resolveMessageLink(task) {
        if (task.messageLink)
            return task.messageLink;
        try {
            return await this.options.messageLinkFor?.(task.chatId, task.messageIds[0]);
        }
        catch {
            return undefined;
        }
    }
    async recoverOnStartup() {
        const recovery = this.options.config.recovery;
        if (!recovery.enabled)
            return;
        if (recovery.resumeTasks) {
            await this.resumeOpenTasks();
        }
        if (recovery.onStartup) {
            await this.pullStartupWindow();
        }
    }
    async pullStartupWindow() {
        const recovery = this.options.config.recovery;
        if (!this.options.platform.capabilities().groupHistory) {
            this.options.logger.warn("recovery skipped: platform has no groupHistory capability");
            return;
        }
        const endTime = Date.now();
        const configuredStart = endTime - recovery.lookbackSeconds * 1000;
        this.options.logger.info("startup recovery pull", {
            startTime: new Date(configuredStart).toISOString(),
            endTime: new Date(endTime).toISOString(),
            groups: this.options.groupIds.size,
        });
        for (const chatId of this.options.groupIds) {
            try {
                const cursor = this.options.lastCursor?.("feishu", chatId);
                const cursorStart = cursor && cursor < endTime
                    ? Math.max(cursor - 60_000, endTime - 7 * 24 * 3600_000)
                    : undefined;
                const startTime = cursorStart
                    ? Math.max(configuredStart, cursorStart)
                    : configuredStart;
                const result = await this.options.platform.listMessages({
                    chatId,
                    startTime,
                    endTime,
                    maxPages: 20,
                    maxMessages: recovery.maxMessages,
                });
                if (result.messages.length === 0)
                    continue;
                const messageIds = result.messages.map((message) => `${message.platform}:${message.messageId}`);
                const unprocessed = result.messages.filter((message) => !this.options.dedup.has(`${message.platform}:${message.messageId}`, chatId));
                this.options.logger.info("startup recovery fetched", {
                    chatId,
                    fetched: result.messages.length,
                    unprocessed: unprocessed.length,
                    unique: new Set(messageIds).size,
                });
                const allMentions = recovery.includeMentions
                    ? result.messages.filter((message) => this.options.isMention(message))
                    : [];
                const mentions = [];
                for (const message of allMentions) {
                    const key = `${message.platform}:${message.messageId}`;
                    if (this.options.historyMentions.has(key, chatId))
                        continue;
                    if (this.options.sentReplies.hasSource(message.messageId)) {
                        this.options.historyMentions.add(key, chatId);
                        continue;
                    }
                    mentions.push(message);
                }
                await this.options.historyMentions.flush();
                const plain = unprocessed
                    .filter((message) => !this.options.isMention(message))
                    .slice(-recovery.maxPlainMessagesPerGroup);
                this.options.logger.info("startup recovery classified", {
                    chatId,
                    unprocessed: unprocessed.length,
                    mentions: mentions.length,
                    plain: plain.length,
                });
                for (const message of mentions) {
                    const key = `${message.platform}:${message.messageId}`;
                    try {
                        this.options.dedup.delete(key, chatId);
                        await this.options.ingest(message, true);
                        this.options.historyMentions.add(key, chatId);
                        await this.options.historyMentions.flush();
                    }
                    catch (error) {
                        this.options.logger.error("historical mention processing failed; will retry", {
                            messageId: message.messageId,
                            chatId,
                            error: toErrorMessage(error),
                        });
                    }
                }
                if (recovery.includeRelevantPlain) {
                    if (plain.length > 0)
                        await this.options.ingestBatch(plain);
                }
                await this.options.recordCursor(chatId, endTime);
            }
            catch (error) {
                this.options.logger.error("startup recovery failed for group; continuing", {
                    chatId,
                    error: toErrorMessage(error),
                });
            }
        }
    }
    async sendPendingTaskNotices(title, notices, footer) {
        const groups = new Map();
        for (const notice of notices) {
            const existing = groups.get(notice.task.chatId);
            if (existing)
                existing.notices.push(notice);
            else
                groups.set(notice.task.chatId, { chatLabel: notice.chatLabel, notices: [notice] });
        }
        for (const group of groups.values()) {
            const first = group.notices[0];
            const states = [...new Set(group.notices.map((notice) => notice.task.state))];
            const status = states.length === 1 ? `${states[0]} · ${group.notices.length} 条` : `${group.notices.length} 条待处理`;
            const firstLink = await this.resolveMessageLink(first.task);
            const link = {
                label: firstLink ? "打开原消息" : "打开群聊",
                url: firstLink ??
                    `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(first.task.chatId)}`,
            };
            const sections = await Promise.all(group.notices.map(async (notice) => {
                const noticeLink = await this.resolveMessageLink(notice.task);
                return {
                    title: notice.task.title,
                    meta: notice.task.state,
                    detail: `来源：${notice.chatLabel} / ${notice.senderLabel}`,
                    ...(noticeLink ? { link: { label: "查看原消息", url: noticeLink } } : {}),
                };
            }));
            const displayTitle = `${title} · ${group.chatLabel}`;
            const text = [
                displayTitle,
                status,
                ...group.notices.flatMap((notice) => [
                    "━━━━━━━━━━",
                    `${notice.task.title} · ${notice.task.state}`,
                    `来源：${notice.chatLabel} / ${notice.senderLabel}`,
                ]),
                footer,
                `${link.label}：${link.url}`,
            ].join("\n");
            if (this.options.sendOwnerNotification) {
                await this.options.sendOwnerNotification({
                    title: displayTitle,
                    headerMeta: { right: status },
                    sections,
                    link,
                    footer,
                });
            }
            else {
                await this.options.sendToOwner(text);
            }
        }
    }
    async sendTaskNotice(title, subtitle, task, footer, labels) {
        const messageLink = await this.resolveMessageLink(task);
        const link = {
            label: messageLink ? "打开原消息" : "打开群聊",
            url: messageLink ??
                `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(task.chatId)}`,
        };
        const text = [
            `${title} · ${labels.chatLabel}：${task.title}`,
            `状态：${task.state}`,
            `来源：${labels.chatLabel} / ${labels.senderLabel}`,
            `${link.label}：${link.url}`,
            footer,
        ].join("\n");
        if (this.options.sendOwnerNotification) {
            await this.options.sendOwnerNotification({
                title: `${title} · ${labels.chatLabel}`,
                subtitle,
                sections: [
                    {
                        title: task.title,
                        meta: task.state,
                        detail: `来源：${labels.chatLabel} / ${labels.senderLabel}`,
                        ...(messageLink ? { link: { label: "查看原消息", url: messageLink } } : {}),
                    },
                ],
                link,
                footer,
            });
        }
        else {
            await this.options.sendToOwner(text);
        }
    }
    async resumeOpenTasks() {
        const recovery = this.options.config.recovery;
        const now = Date.now();
        const maxAgeMs = recovery.resumeMaxAgeDays * 86_400_000;
        const tasks = await this.options.tasks.list();
        let resumed = 0;
        let interrupted = 0;
        const pendingNotices = [];
        for (const task of tasks) {
            if (task.archivedAt)
                continue;
            if (task.state === "needs_info" && task.source === "group_scan" && !task.lastAnalyzedAt)
                continue;
            if (now - task.updatedAt > maxAgeMs)
                continue;
            if (task.state === "done" || task.state === "rejected" || task.state === "canceled") {
                continue;
            }
            if (task.state === "executing" || task.state === "verifying") {
                const staleMs = recovery.staleRunningMinutes * 60_000;
                if (now - task.updatedAt < staleMs)
                    continue;
                task.state = "awaiting_approval";
                task.updatedAt = now;
                await this.options.tasks.save(task);
                interrupted++;
                const labels = (await this.options.describeTask?.(task)) ?? {
                    chatLabel: task.chatName ?? "群",
                    senderLabel: task.requester.displayName ?? "成员",
                };
                await this.sendTaskNotice("执行中断", task.state, task, "上次执行被中断，已暂停等待你重新批准；不会自动重放代码修改。", labels);
                continue;
            }
            if ((task.state === "awaiting_approval" || task.state === "needs_info") &&
                this.options.pending.findForTask(task.id)) {
                continue;
            }
            if (task.state === "analyzing") {
                task.state = "analyzing";
                task.updatedAt = now;
                await this.options.tasks.save(task);
                this.options.track(this.options.analyzeTask(task)).catch((error) => {
                    this.options.logger.error("resumed task analysis failed", {
                        taskId: task.id,
                        error: toErrorMessage(error),
                    });
                });
                resumed++;
                continue;
            }
            const nudgeMs = recovery.nudgeHours * 3600_000;
            if ((task.state === "awaiting_approval" || task.state === "needs_info") &&
                (nudgeMs === 0 || now - (task.lastNudgeAt ?? 0) > nudgeMs)) {
                task.lastNudgeAt = now;
                task.updatedAt = now;
                await this.options.tasks.save(task);
                const labels = (await this.options.describeTask?.(task)) ?? {
                    chatLabel: task.chatName ?? "群",
                    senderLabel: task.requester.displayName ?? "成员",
                };
                pendingNotices.push({
                    task,
                    chatLabel: labels.chatLabel,
                    senderLabel: labels.senderLabel,
                });
                resumed++;
            }
        }
        if (pendingNotices.length > 0) {
            await this.sendPendingTaskNotices("未完成任务提醒", pendingNotices, "请在原审批卡或群里处理。");
        }
        this.options.logger.info("task resume finished", { resumed, interrupted });
        if (resumed > 0 || interrupted > 0) {
            await this.options.sendToOwner(`启动恢复：续作 ${resumed} 个未完成任务，中断 ${interrupted} 个执行。`);
        }
    }
}
//# sourceMappingURL=recovery-service.js.map