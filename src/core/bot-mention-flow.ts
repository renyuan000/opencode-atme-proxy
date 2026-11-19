import type { AppConfig } from "./config.js";
import type { AuditLog } from "./audit.js";
import type { IntentService } from "./intent-service.js";
import type { Logger } from "./logger.js";
import type { OpenCodeBridge } from "./opencode.js";
import type { PlatformAdapter } from "./ports.js";
import type { TokenBucket } from "./rate-limit.js";
import type { ReplyService } from "./reply-service.js";
import type { SessionManager, SessionPermission } from "./session-manager.js";
import type { BotIntent, IncomingMessage } from "./types.js";
import { sha256, toErrorMessage, truncate } from "./util.js";

export interface BotMentionFlowOptions {
  config: AppConfig;
  logger: Logger;
  intentService: IntentService;
  replyService: ReplyService;
  sessionManager: SessionManager;
  bridge: OpenCodeBridge;
  platform: PlatformAdapter;
  sendLimiter: TokenBucket;
  audit: AuditLog;
  readOnlyPermission: SessionPermission[];
  ownerOpenId(): string | undefined;
  ownerName(): string;
  resolveProject(chatId: string): Promise<{ worktree: string; resolved: boolean }>;
  sendToOwner(text: string): Promise<boolean>;
  sendToApprover(text: string): Promise<boolean>;
  safeReply(message: IncomingMessage, text: string): Promise<boolean>;
  markProcessed(message: IncomingMessage): Promise<void>;
  rememberFromMention(message: IncomingMessage, intent: BotIntent, analysis?: string): void;
}

export class BotMentionFlow {
  constructor(private readonly options: BotMentionFlowOptions) {}

  async handle(message: IncomingMessage, signal: AbortSignal): Promise<void> {
    const enriched = message;
    const intent = await this.options.intentService.decideBotIntent(enriched, signal);
    if (intent.action === "no_reply") {
      this.options.logger.info("bot mention skipped by necessity check", {
        messageId: message.messageId,
        reason: intent.reason,
        confidence: intent.confidence,
      });
      await this.options.markProcessed(message);
      await this.options.audit.append({
        actor: { system: true },
        action: "bot_mention_skipped",
        details: { messageId: message.messageId, reason: intent.reason },
      });
      return;
    }

    if (intent.action === "notify_owner") {
      const notified = await this.sendOwnerDecisionCard(message, intent, "notify");
      this.options.rememberFromMention(message, intent);
      if (notified) await this.options.markProcessed(message);
      await this.options.audit.append({
        actor: { system: true },
        action: "bot_mention_owner_notified",
        details: { messageId: message.messageId, kind: intent.kind, reason: intent.reason },
      });
      return;
    }

    if (intent.action === "need_decision") {
      const analysis = await this.analyzeBotRequest(message, intent, signal);
      const notified = await this.sendOwnerDecisionCard(message, intent, "decision", analysis);
      this.options.rememberFromMention(message, intent, analysis);
      if (notified) await this.options.markProcessed(message);
      await this.options.audit.append({
        actor: { system: true },
        action: "bot_mention_escalated",
        details: {
          messageId: message.messageId,
          kind: intent.kind,
          reason: intent.reason,
          analysisHash: analysis ? sha256(analysis).slice(0, 12) : undefined,
        },
      });
      return;
    }

    const style = intent.style;
    const ackTimer = this.options.config.reply.acknowledgeLongTasks
      ? setTimeout(() => {
          void this.options.safeReply(message, this.options.config.reply.ackText);
        }, this.options.config.reply.ackDelayMs)
      : undefined;
    if (ackTimer) ackTimer.unref?.();
    let replied = false;
    try {
      const reply = await this.options.replyService.draft(enriched, style, signal);
      if (ackTimer) clearTimeout(ackTimer);
      replied = await this.options.safeReply(message, this.sanitize(reply));
      this.options.rememberFromMention(message, intent, reply);
    } catch (error) {
      this.options.logger.error("bot mention handling failed", {
        messageId: message.messageId,
        error: toErrorMessage(error),
      });
      replied = await this.options.safeReply(message, "处理失败，请稍后重试或直接联系我。");
    } finally {
      if (ackTimer) clearTimeout(ackTimer);
    }
    if (replied) await this.options.markProcessed(message);
    await this.options.audit.append({
      actor: { system: true },
      action: "bot_mention_replied",
      details: { messageId: message.messageId, style, reason: intent.reason },
    });
  }

  private async analyzeBotRequest(
    message: IncomingMessage,
    intent: BotIntent,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    if (!this.options.config.botReply.analyzeBeforeEscalate) return undefined;
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
      } finally {
        release();
        await this.options.sessionManager.finishSession(
          sessionId,
          title,
          project.worktree,
          "bot_request_analysis",
        );
      }
    } catch (error) {
      this.options.logger.warn("bot request analysis failed", {
        messageId: message.messageId,
        error: toErrorMessage(error),
      });
      return undefined;
    }
  }

  private async sendOwnerDecisionCard(
    message: IncomingMessage,
    intent: BotIntent,
    mode: "decision" | "notify",
    analysis?: string,
  ): Promise<boolean> {
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
    return this.options.sendToOwner(text);
  }

  private sanitize(text: string): string {
    return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
  }
}
