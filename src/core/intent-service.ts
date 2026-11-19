import type { AppConfig } from "./config.js";
import type { ChatContextStore } from "./chat-context.js";
import type { Logger } from "./logger.js";
import type { LlmClient, RelevanceService } from "./relevance.js";
import { buildBotIntentPrompt, parseBotIntent } from "./relevance.js";
import type { ReplyStyleOptions } from "./reply-style.js";
import { detectReplyStyle } from "./reply-style.js";
import type { BotIntent, Classification, IncomingMessage } from "./types.js";
import { toErrorMessage, truncate } from "./util.js";

export interface IntentServiceOptions {
  config: AppConfig;
  relevance: () => RelevanceService;
  llm: LlmClient;
  filterEnabled: boolean;
  chatContext: ChatContextStore;
  replyOptions: ReplyStyleOptions;
  logger: Logger;
}

export class IntentService {
  constructor(private readonly options: IntentServiceOptions) {}

  async classifyOne(
    message: IncomingMessage,
    signal: AbortSignal,
  ): Promise<Classification | undefined> {
    if (!this.options.filterEnabled) return undefined;
    try {
      const { items } = await this.options.relevance().classify([message], signal);
      return items.find((item) => item.messageId === message.messageId);
    } catch (error) {
      this.options.logger.error("classification failed; falling back to approval", {
        messageId: message.messageId,
        error: toErrorMessage(error),
      });
      return undefined;
    }
  }

  async decideBotIntent(message: IncomingMessage, signal: AbortSignal): Promise<BotIntent> {
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
      const trivial = /^(谢谢|收到|好的| ok|ok|测试一下|test)[！!。.\s]*$/i.test(
        message.text.trim(),
      );
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
    const intentText = message.replyToMessageId
      ? `${message.text}\n（这条消息引用了上一条消息/文件；请认为引用内容可读取，不要仅因正文没有文件就判定信息不足。）`
      : message.text;
    try {
      this.options.logger.info("bot intent llm start", { messageId: message.messageId });
      const completion = await this.options.llm.complete(
        buildBotIntentPrompt({
          text: intentText,
          history: recent,
          profile,
          allowNoReply: config.botReply.allowNoReply,
        }),
        signal,
      );
      this.options.logger.info("bot intent llm done", {
        messageId: message.messageId,
        chars: completion.text.length,
      });
      const intent = parseBotIntent(completion.text, {
        text: message.text,
        history: recent,
        profile,
        allowNoReply: config.botReply.allowNoReply,
      });
      if (intent.action === "need_decision" && isLearningOnlyRequest(message.text)) {
        return {
          ...intent,
          action: "answer",
          reason: `${intent.reason}（仅学习/阅读/分析，不涉及承诺或变更，直接回答）`,
        };
      }
      if (
        intent.action === "answer" &&
        intent.confidence < config.botReply.minAnswerConfidence
      ) {
        return {
          ...intent,
          action: config.botReply.escalateWhenUnsure ? "need_decision" : "no_reply",
          reason: `${intent.reason} (low confidence ${intent.confidence.toFixed(2)})`,
        };
      }
      return intent;
    } catch (error) {
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
function isLearningOnlyRequest(text: string): boolean {
  const learning = /(先学习|学习下|学习一下|先看看|看一下|理解一下|阅读|熟悉|分析一下|总结一下|看看.{0,6}原型|读一下)/;
  const committing = /(实现|开发|修改|提交|部署|上线|排期|承诺|合并|发版|执行)/;
  return learning.test(text) && !committing.test(text);
}
