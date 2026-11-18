import type { AppConfig } from "./config.js";
import type { AuditLog } from "./audit.js";
import type { IntentService } from "./intent-service.js";
import type { Logger } from "./logger.js";
import type { ReplyService } from "./reply-service.js";
import type { TaskService } from "./task-service.js";
import type { TaskStore } from "./task-store.js";
import type { IncomingMessage, TaskRecord } from "./types.js";
import { detectReplyDepth, detectReplyStyle } from "./reply-style.js";
import { toErrorMessage, truncate } from "./util.js";

const ASSISTANT_LABEL = "（助手代答）";

export interface MeMentionFlowOptions {
  config: AppConfig;
  logger: Logger;
  intentService: IntentService;
  replyService: ReplyService;
  taskService: TaskService;
  tasks: TaskStore;
  audit: AuditLog;
  prepare(message: IncomingMessage, signal: AbortSignal): Promise<{
    enriched: IncomingMessage;
    burst: IncomingMessage[];
  }>;
  markProcessed(message: IncomingMessage): Promise<void>;
  safeReply(message: IncomingMessage, text: string): Promise<boolean>;
  sendToApprover(text: string): Promise<boolean>;
}

export class MeMentionFlow {
  constructor(private readonly options: MeMentionFlowOptions) {}

  async handle(message: IncomingMessage, signal: AbortSignal): Promise<void> {
    const { enriched, burst } = await this.options.prepare(message, signal);
    const classification = await this.options.intentService.classifyOne(enriched, signal);
    if (
      classification?.actionability === "task" &&
      classification.confidence >= this.options.config.filter.minTaskConfidence
    ) {
      const task = await this.options.taskService.ensureTask(
        enriched,
        classification,
        "mention_me",
      );
      if (task) {
        await this.options.markProcessed(message);
        for (const followup of burst) await this.options.markProcessed(followup);
        return;
      }
    }
    const style = detectReplyStyle(enriched, this.options.config.reply);
    const depth = detectReplyDepth(enriched, this.options.config.reply);
    const decision = await this.options.replyService.shouldReplyToMention(
      enriched,
      classification,
    );
    if (!decision.reply) {
      this.options.logger.info("mention skipped by reply necessity", {
        messageId: message.messageId,
        reason: decision.reason,
      });
      await this.options.markProcessed(message);
      for (const followup of burst) await this.options.markProcessed(followup);
      await this.options.audit.append({
        actor: { system: true },
        action: "mention_skipped",
        details: { messageId: message.messageId, reason: decision.reason },
      });
      return;
    }
    const task = await this.options.replyService.createReplyTask(enriched, classification);
    const autoReply =
      this.options.config.policy.autoReplyOnMention &&
      classification?.actionability !== "task" &&
      (classification?.confidence ?? 0) >= this.options.config.filter.minTaskConfidence;
    if (autoReply) {
      try {
        const reply =
          depth === "ack"
            ? "收到"
            : await this.options.replyService.draft(enriched, style, signal, depth);
        const replied = await this.options.safeReply(
          message,
          `${ASSISTANT_LABEL} ${this.sanitize(reply)}`,
        );
        if (!replied) throw new Error("reply failed");
        await this.complete(task);
        await this.options.audit.append({
          actor: { system: true },
          action: "mention_auto_replied",
          taskId: task.id,
          details: { messageId: message.messageId, style },
        });
        await this.options.markProcessed(message);
        return;
      } catch (error) {
        this.options.logger.error("auto reply failed; falling back to approval", {
          taskId: task.id,
          error: toErrorMessage(error),
        });
      }
    }
    try {
      await this.options.replyService.sendReplyApproval(task, message, enriched, depth);
      await this.options.markProcessed(message);
      for (const followup of burst) await this.options.markProcessed(followup);
    } catch (error) {
      this.options.logger.error("failed to send reply approval", {
        taskId: task.id,
        error: toErrorMessage(error),
      });
      const notified = await this.options.sendToApprover(
        `有人 @你，但审批卡发送失败：${truncate(message.text, 200)}\n发送人：${message.sender.displayName ?? message.sender.id}`,
      );
      if (notified) await this.options.markProcessed(message);
    }
  }

  private async complete(task: TaskRecord): Promise<void> {
    task.state = "done";
    task.updatedAt = Date.now();
    await this.options.tasks.save(task);
  }

  private sanitize(text: string): string {
    return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
  }
}
