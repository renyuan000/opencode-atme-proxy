import { buildBotIntentPrompt, parseBotIntent } from "./relevance.js";
import { detectReplyStyle } from "./reply-style.js";
import { toErrorMessage, truncate } from "./util.js";
export class IntentService {
    options;
    constructor(options) {
        this.options = options;
    }
    async classifyOne(message, signal) {
        if (!this.options.filterEnabled)
            return undefined;
        try {
            const { items } = await this.options.relevance().classify([message], signal);
            return items.find((item) => item.messageId === message.messageId);
        }
        catch (error) {
            this.options.logger.error("classification failed; falling back to approval", {
                messageId: message.messageId,
                error: toErrorMessage(error),
            });
            return undefined;
        }
    }
    async decideBotIntent(message, signal) {
        const config = this.options.config;
        if (!config.botReply.enabled) {
            return {
                action: "answer",
                kind: "question",
                style: detectReplyStyle(message, this.options.replyOptions),
                confidence: 1,
                reason: "necessity check disabled",
            };
        }
        if (!config.filter.enabled) {
            const trivial = /^(谢谢|收到|好的| ok|ok|测试一下|test)[！!。.\s]*$/i.test(message.text.trim());
            return {
                action: trivial ? "no_reply" : "answer",
                kind: trivial ? "chat" : "question",
                style: detectReplyStyle(message, this.options.replyOptions),
                confidence: 0.5,
                reason: trivial ? "寒暄/确认，无需回复" : "未启用筛选模型，按普通问题回答",
            };
        }
        const recent = config.context.enabled
            ? this.options.chatContext
                .recent(`${message.platform}:${message.chat.id}`, 6, message.messageId)
                .map((item) => `${item.senderName ?? item.senderId}: ${truncate(item.text, 160)}`)
            : [];
        const profile = {
            name: config.filter.profile.name,
            role: config.filter.profile.role,
            keywords: config.filter.profile.keywords,
            projects: config.filter.profile.projects,
            tasks: config.filter.profile.tasks,
        };
        try {
            const completion = await this.options.llm.complete(buildBotIntentPrompt({
                text: message.text,
                history: recent,
                profile,
                allowNoReply: config.botReply.allowNoReply,
            }), signal);
            const intent = parseBotIntent(completion.text, {
                text: message.text,
                history: recent,
                profile,
                allowNoReply: config.botReply.allowNoReply,
            });
            if (intent.action === "answer" &&
                intent.confidence < config.botReply.minAnswerConfidence) {
                return {
                    ...intent,
                    action: config.botReply.escalateWhenUnsure ? "need_decision" : "no_reply",
                    reason: `${intent.reason} (low confidence ${intent.confidence.toFixed(2)})`,
                };
            }
            return intent;
        }
        catch (error) {
            this.options.logger.warn("bot intent classification failed", {
                messageId: message.messageId,
                error: toErrorMessage(error),
            });
            return {
                action: config.botReply.escalateWhenUnsure ? "need_decision" : "no_reply",
                kind: "other",
                style: detectReplyStyle(message, this.options.replyOptions),
                confidence: 0,
                reason: "intent classification failed",
            };
        }
    }
}
//# sourceMappingURL=intent-service.js.map