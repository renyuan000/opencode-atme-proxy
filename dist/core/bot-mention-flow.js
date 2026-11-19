import { sha256, toErrorMessage, truncate } from "./util.js";
export class BotMentionFlow {
    options;
    constructor(options) {
        this.options = options;
    }
    missingContextNotified = new Set();
    async handle(message, signal) {
        const enrichment = await this.options.replyService.enrichWithQuoted(message);
        const enriched = enrichment.message;
        this.options.logger.info("bot mention handling", { messageId: message.messageId });
        if (!enrichment.found && this.expectsAttachment(message) && !this.missingContextNotified.has(message.messageId)) {
            this.missingContextNotified.add(message.messageId);
            await this.options.sendToOwner(`没回溯到这条消息的文件或引用内容，请补充文件/链接/路径：\n群：${message.chat.name ?? message.chat.id}\n消息：${message.text.slice(0, 300)}`, message.messageId);
        }
        let decision;
        try {
            decision = await this.withTimeout(signal, this.options.config.concurrency.replyTimeoutMs ?? 120_000, "decision", (child) => this.options.replyService.respond(enriched, child));
        }
        catch (error) {
            this.options.logger.error("bot decision failed", {
                messageId: message.messageId,
                error: toErrorMessage(error),
            });
            await this.options.safeReply(message, "处理失败，请稍后重试或直接联系我。");
            return;
        }
        const intent = {
            action: decision.action,
            kind: decision.kind ?? "question",
            style: decision.style ?? "concise",
            confidence: 1,
            reason: decision.reason,
            ...(decision.summary ? { summary: decision.summary } : {}),
        };
        this.options.logger.info("bot decision decided", {
            messageId: message.messageId,
            action: decision.action,
            kind: intent.kind,
            reason: decision.reason,
        });
        if (decision.action === "no_reply") {
            this.options.logger.info("bot mention skipped by unified decision", {
                messageId: message.messageId,
                reason: decision.reason,
            });
            await this.options.markProcessed(message);
            await this.options.audit.append({
                actor: { system: true },
                action: "bot_mention_skipped",
                details: { messageId: message.messageId, reason: decision.reason },
            });
            return;
        }
        if (decision.action === "notify_owner" || decision.action === "need_decision") {
            const notified = await this.sendOwnerDecisionCard(message, intent, decision.action === "notify_owner" ? "notify" : "decision", decision.analysis);
            if (notified)
                this.options.rememberOwnerTarget(message);
            this.options.rememberFromMention(message, intent, decision.analysis);
            if (notified)
                await this.options.markProcessed(message);
            await this.options.audit.append({
                actor: { system: true },
                action: decision.action === "notify_owner"
                    ? "bot_mention_owner_notified"
                    : "bot_mention_escalated",
                details: {
                    messageId: message.messageId,
                    kind: intent.kind,
                    reason: decision.reason,
                    ...(decision.analysis
                        ? { analysisHash: sha256(decision.analysis).slice(0, 12) }
                        : {}),
                },
            });
            return;
        }
        const reply = decision.reply?.trim();
        if (!reply) {
            await this.options.markProcessed(message);
            await this.options.audit.append({
                actor: { system: true },
                action: "bot_mention_skipped",
                details: { messageId: message.messageId, reason: "empty unified reply" },
            });
            return;
        }
        try {
            const replied = await this.options.safeReply(message, this.sanitize(reply));
            this.options.rememberFromMention(message, intent, reply);
            if (replied)
                await this.options.markProcessed(message);
            await this.options.audit.append({
                actor: { system: true },
                action: "bot_mention_replied",
                details: { messageId: message.messageId, style: intent.style, reason: decision.reason },
            });
        }
        catch (error) {
            this.options.logger.error("bot mention reply failed", {
                messageId: message.messageId,
                error: toErrorMessage(error),
            });
            await this.options.safeReply(message, "处理失败，请稍后重试或直接联系我。");
        }
    }
    expectsAttachment(message) {
        if (message.replyToMessageId)
            return true;
        return /(原型|文件|附件|文档|截图|表格|html|pdf|docx?|\/(wiki|docx|docs|sheets)\/)/i.test(message.text);
    }
    async withTimeout(parent, timeoutMs, label, run) {
        if (parent.aborted)
            throw parent.reason;
        const controller = new AbortController();
        const onAbort = () => controller.abort(parent.reason);
        parent.addEventListener("abort", onAbort, { once: true });
        const timer = setTimeout(() => controller.abort(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
        try {
            return await run(controller.signal);
        }
        finally {
            clearTimeout(timer);
            parent.removeEventListener("abort", onAbort);
        }
    }
    async analyzeBotRequest(message, intent, signal) {
        if (!this.options.config.botReply.analyzeBeforeEscalate)
            return undefined;
        try {
            const project = await this.options.resolveProject(message.chat.id);
            const prompt = [
                "你是研发任务助手。请对下面这个群里的请求做简短可行性分析，供主人决策。",
                "只输出 3-5 行：请求实质、影响范围、建议做/不做/先确认什么、风险。",
                "不要执行代码，不要承诺排期，不要编造。",
                `消息类型：${intent.kind}`,
                `发送人：${message.sender.displayName ?? message.sender.id}`,
                `内容：${message.text}`,
                `当前项目目录：${project.worktree}`,
            ].join("\n");
            const title = `${this.options.config.opencode.sessionTitlePrefix}:analyze:${message.messageId}`;
            const { sessionId, release } = await this.options.sessionManager.createChildSession({
                platform: message.platform,
                chatId: message.chat.id,
                directory: project.worktree,
                title,
                role: "analysis",
                permission: this.options.readOnlyPermission,
                signal,
            });
            try {
                const raw = await this.options.bridge.prompt(sessionId, {
                    directory: project.worktree,
                    title,
                    text: prompt,
                    signal,
                });
                return truncate(raw.trim(), 600);
            }
            finally {
                release();
                await this.options.sessionManager.finishSession(sessionId, title, project.worktree, "bot_request_analysis");
            }
        }
        catch (error) {
            this.options.logger.warn("bot request analysis failed", {
                messageId: message.messageId,
                error: toErrorMessage(error),
            });
            return undefined;
        }
    }
    async sendOwnerDecisionCard(message, intent, mode, analysis) {
        const text = [
            mode === "decision"
                ? "群里有人 @机器人，需要你判断是否要做"
                : "群里有人 @机器人，仅需你知会",
            `类型：${intent.kind}`,
            `来源：${message.chat.name ?? message.chat.id} / ${message.sender.displayName ?? message.sender.id}`,
            `内容：${truncate(intent.summary ?? message.text, 240)}`,
            `判断：${intent.reason}`,
            ...(intent.suggestedAction ? [`建议：${intent.suggestedAction}`] : []),
            ...(analysis ? [`分析：\n${analysis}`] : []),
        ].join("\n");
        return this.options.sendToOwner(text, message.messageId);
    }
    sanitize(text) {
        return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
    }
}
//# sourceMappingURL=bot-mention-flow.js.map