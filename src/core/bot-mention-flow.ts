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
  sendToOwner(text: string, sourceMessageId?: string): Promise<boolean>;
  sendToApprover(text: string): Promise<boolean>;
  safeReply(message: IncomingMessage, text: string): Promise<boolean>;
  markProcessed(message: IncomingMessage): Promise<void>;
  rememberFromMention(message: IncomingMessage, intent: BotIntent, analysis?: string): void;
  rememberOwnerTarget(message: IncomingMessage): void;
}

export class BotMentionFlow {
  constructor(private readonly options: BotMentionFlowOptions) {}

  private readonly missingContextNotified = new Set<string>();

  async handle(message: IncomingMessage, signal: AbortSignal): Promise<void> {
    const enrichment = await this.options.replyService.enrichWithQuoted(message);
    const enriched = enrichment.message;
    this.options.logger.info("bot mention handling", { messageId: message.messageId });
    if (!enrichment.found && this.expectsAttachment(message) && !this.missingContextNotified.has(message.messageId)) {
      this.missingContextNotified.add(message.messageId);
      await this.options.sendToOwner(
        `没回溯到这条消息的文件或引用内容，请补充文件/链接/路径：\n群：${message.chat.name ?? message.chat.id}\n消息：${message.text.slice(0, 300)}`,
        message.messageId,
      );
    }
    let decision;
    try {
      decision = await this.withTimeout(
        signal,
        this.options.config.concurrency.replyTimeoutMs ?? 120_000,
        "decision",
        (child) => this.options.replyService.respond(enriched, child),
      );
    } catch (error) {
      this.options.logger.error("bot decision failed", {
        messageId: message.messageId,
        error: toErrorMessage(error),
      });
      if (message.chat.kind === "direct") {
        await this.options.safeReply(message, "处理失败，请稍后重试或直接联系我。");
      } else {
        await this.options.sendToOwner(
          `群 @机器人 处理失败：\n群：${message.chat.name ?? message.chat.id}\n消息：${message.text.slice(0, 300)}\n原因：${toErrorMessage(error)}`,
          message.messageId,
        );
      }
      return;
    }
    const intent: BotIntent = {
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

    const wantsPrivate = /(私聊|只发我|不要发群|不要群里|私发我|分析给我)/.test(message.text);
    if (wantsPrivate && decision.action !== "answer") {
      const privateText = decision.analysis?.trim() || decision.reply?.trim();
      if (privateText) {
        const sent = await this.options.sendToOwner(
          `分析结果：\n${this.sanitize(privateText)}`,
          message.messageId,
        );
        if (sent) this.options.markProcessed(message);
        this.options.rememberOwnerTarget(message);
        await this.options.audit.append({
          actor: { system: true },
          action: "bot_mention_private_answered",
          details: { messageId: message.messageId, reason: decision.reason },
        });
        return;
      }
    }

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
      const notified = await this.sendOwnerDecisionCard(
        message,
        intent,
        decision.action === "notify_owner" ? "notify" : "decision",
        decision.analysis,
      );
      if (notified) this.options.rememberOwnerTarget(message);
      this.options.rememberFromMention(message, intent, decision.analysis);
      if (notified) await this.options.markProcessed(message);
      await this.options.audit.append({
        actor: { system: true },
        action:
          decision.action === "notify_owner"
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
    if (wantsPrivate) {
      const sent = await this.options.sendToOwner(`分析结果：\n${this.sanitize(reply)}`, message.messageId);
      if (sent) await this.options.markProcessed(message);
      await this.options.audit.append({
        actor: { system: true },
        action: "bot_mention_private_answered",
        details: { messageId: message.messageId, reason: decision.reason },
      });
      return;
    }

    try {
      const replied = await this.options.safeReply(message, this.sanitize(reply));
      this.options.rememberFromMention(message, intent, reply);
      if (replied) await this.options.markProcessed(message);
      await this.options.audit.append({
        actor: { system: true },
        action: "bot_mention_replied",
        details: { messageId: message.messageId, style: intent.style, reason: decision.reason },
      });
    } catch (error) {
      this.options.logger.error("bot mention reply failed", {
        messageId: message.messageId,
        error: toErrorMessage(error),
      });
      await this.options.safeReply(message, "处理失败，请稍后重试或直接联系我。");
    }
  }

  private expectsAttachment(message: IncomingMessage): boolean {
    if (message.replyToMessageId) return true;
    return /(原型|文件|附件|文档|截图|表格|html|pdf|docx?|\/(wiki|docx|docs|sheets)\/)/i.test(message.text);
  }

  private async withTimeout<T>(
    parent: AbortSignal,
    timeoutMs: number,
    label: string,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (parent.aborted) throw parent.reason;
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(parent.reason);
    parent.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
    try {
      return await run(controller.signal);
    } finally {
      clearTimeout(timer);
      parent.removeEventListener("abort", onAbort);
    }
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
    return this.options.sendToOwner(text, message.messageId);
  }

  private sanitize(text: string): string {
    return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
  }
}
