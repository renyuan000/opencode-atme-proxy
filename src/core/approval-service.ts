import type { AppConfig } from "./config.js";
import type { AuditLog } from "./audit.js";
import type { ApprovalStore } from "./approval-store.js";
import type { Logger } from "./logger.js";
import type { PendingStore } from "./pending-store.js";
import type { PendingCard } from "./pending-store.js";
import type { PlatformAdapter } from "./ports.js";
import type { SentReplyStore } from "./sent-reply-store.js";
import type { TaskStore } from "./task-store.js";
import type {
  PendingReplySummary,
  PlatformAction,
  PlatformActionResult,
  ReplyManagementView,
  TaskRecord,
} from "./types.js";
import { assertTransition, canTransition } from "./task-state.js";

export interface ApprovalServiceOptions {
  config: AppConfig;
  pending: PendingStore;
  tasks: TaskStore;
  approvals: ApprovalStore;
  audit: AuditLog;
  platform: PlatformAdapter;
  logger: Logger;
  ownerOpenId(): string | undefined;
  sendToApprover(text: string): Promise<boolean>;
  approveReply(action: PlatformAction, pending: PendingCard): Promise<boolean>;
  sentReplies: SentReplyStore;
  startExecution(task: TaskRecord, planHash: string): void;
}

export class ApprovalService {
  constructor(private readonly options: ApprovalServiceOptions) {}

  private readonly inflight = new Set<string>();
  private readonly nameCache = new Map<string, string>();

  async sweepExpiredApprovals(): Promise<void> {
    const ttlMs = this.options.config.policy.approvalTimeoutHours * 3600_000;
    const now = Date.now();
    for (const [key, card] of this.options.pending.snapshot()) {
      if (now - card.createdAt < ttlMs) continue;
      const task = await this.options.tasks.get(card.taskId);
      if (task && canTransition(task.state, "expired")) {
        task.state = "expired";
        task.updatedAt = now;
        await this.options.tasks.save(task);
      }
      this.options.pending.delete(key);
      await this.options.audit.append({
        actor: { system: true },
        action: "approval_expired",
        taskId: card.taskId,
        details: { planHash: card.planHash },
      });
      await this.options.sendToApprover(`审批已超时：${task?.title ?? card.taskId}`);
    }
    await this.options.pending.flush();
  }

  async isAuthorizedActor(actor: { platform: string; id: string }): Promise<boolean> {
    const ownerId = this.options.ownerOpenId();
    if (ownerId && actor.id === ownerId) return true;
    if (
      this.options.config.platforms.feishu.approvers.some(
        (approver) => approver.openId === actor.id,
      )
    ) {
      return true;
    }
    return this.options.platform.verifyActor(actor as never);
  }

  async onAction(action: PlatformAction): Promise<PlatformActionResult> {
    if (action.action === "reply_manage") {
      return this.handleAction(action);
    }
    const key =
      action.action === "recall_reply"
        ? `recall:${action.replyId ?? "missing"}`
        : action.action === "cancel_pending"
          ? `cancel:${action.taskId}`
          : `approval:${action.taskId}:${action.action}`;
    if (this.inflight.has(key)) {
      return { ok: true, toast: "处理中，请稍候" };
    }
    this.inflight.add(key);
    try {
      return await this.handleAction(action);
    } finally {
      this.inflight.delete(key);
    }
  }

  private async handleAction(action: PlatformAction): Promise<PlatformActionResult> {
    if (action.action === "reply_manage") {
      if (!(await this.isAuthorizedActor(action.actor))) {
        return { ok: false, toast: "无权操作" };
      }
      return (await this.sendReplyManagementCard(false))
        ? { ok: true, toast: "回复管理已发送" }
        : { ok: false, toast: "回复管理卡片发送失败" };
    }
    if (action.action === "cancel_pending") {
      if (!(await this.isAuthorizedActor(action.actor))) {
        return { ok: false, toast: "无权操作" };
      }
      const pending = this.options.pending.get(`${action.taskId}:reply`);
      if (!pending) return { ok: false, toast: "草稿不存在或已处理" };
      if (action.planHash && action.planHash !== pending.planHash) {
        return { ok: false, toast: "草稿已变更，请刷新列表" };
      }
      const confirm = this.options.platform.renderCancelConfirm?.({
        taskId: pending.taskId,
        planHash: pending.planHash,
        ...(pending.draft ? { draft: pending.draft } : {}),
      });
      if (confirm?.kind === "card") {
        return { ok: true, toast: "请确认取消", card: confirm.card };
      }
      return this.cancelPendingNow(action, pending);
    }
    if (action.action === "cancel_pending_confirm") {
      if (!(await this.isAuthorizedActor(action.actor))) {
        return { ok: false, toast: "无权操作" };
      }
      const pending = this.options.pending.get(`${action.taskId}:reply`);
      if (!pending) return { ok: false, toast: "草稿不存在或已处理" };
      if (action.planHash && action.planHash !== pending.planHash) {
        return { ok: false, toast: "草稿已变更，请刷新列表" };
      }
      return this.cancelPendingNow(action, pending);
    }
    if (action.action === "restore_approval") {
      if (!(await this.isAuthorizedActor(action.actor))) {
        return { ok: false, toast: "无权操作" };
      }
      const pending = this.options.pending.get(`${action.taskId}:reply`);
      if (!pending) return { ok: false, toast: "草稿不存在或已处理" };
      const task = await this.options.tasks.get(action.taskId);
      return {
        ok: true,
        toast: "已返回审批",
        card: this.pendingApprovalCard(pending, task),
      };
    }
    if (action.action === "recall_reply") {
      if (!(await this.isAuthorizedActor(action.actor))) {
        return { ok: false, toast: "无权操作" };
      }
      if (!action.replyId) return { ok: false, toast: "缺少回复标识" };
      const record = this.options.sentReplies.get(action.replyId);
      if (!record) return { ok: false, toast: "找不到这条回复" };
      if (record.status === "recalled") {
        return this.replyManagementResult("该回复已撤回");
      }
      if (!this.options.platform.recallMessage) {
        return { ok: false, toast: "当前平台不支持撤回" };
      }
      try {
        await this.options.platform.recallMessage(record.chatId, record.sentMessageId);
      } catch (error) {
        return {
          ok: false,
          toast: `撤回失败：${error instanceof Error ? error.message : String(error)}`,
        };
      }
      await this.options.sentReplies.markRecalled(record.id);
      await this.options.audit.append({
        actor: action.actor,
        action: "reply_recalled",
        details: { messageId: record.sentMessageId, chatId: record.chatId },
      });
      return this.replyManagementResult("已撤回回复");
    }

    const pending =
      this.options.pending.get(`${action.taskId}:develop`) ??
      this.options.pending.get(`${action.taskId}:reply`);
    if (!pending) return { ok: false, toast: "任务不存在或已处理" };
    const actorOk = await this.isAuthorizedActor(action.actor);
    if (!actorOk) {
      await this.options.audit.append({
        actor: action.actor,
        action: "approval_denied",
        taskId: action.taskId,
        details: { reason: "unauthorized actor" },
      });
      return { ok: false, toast: "无权操作" };
    }
    if (action.planHash && action.planHash !== pending.planHash) {
      return { ok: false, toast: "计划已变更，请重新审批" };
    }
    if (action.action === "approve") {
      const approved = await this.approveTask(action);
      if (!approved) {
        return { ok: false, toast: "发送失败，草稿已保留" };
      }
      return {
        ok: true,
        toast: "已批准",
        card: this.resolvedCardFor(pending, "approved"),
      };
    }
    if (action.action === "reject") {
      await this.rejectTask(action);
      return {
        ok: true,
        toast: "已拒绝",
        card: this.resolvedCardFor(pending, "rejected"),
      };
    }
    if (action.action === "revise") {
      return {
        ok: true,
        toast: "请回复补充信息",
        card: this.resolvedCardFor(pending, "revised"),
      };
    }
    if (action.action === "self") {
      const task = await this.options.tasks.get(action.taskId);
      if (task) {
        task.state = "done";
        task.updatedAt = Date.now();
        await this.options.tasks.save(task);
      }
      this.options.pending.deleteForTask(action.taskId);
      await this.options.pending.flush();
      return {
        ok: true,
        toast: "已标记为我自己回",
        card: this.resolvedCardFor(pending, "self"),
      };
    }
    return { ok: false, toast: "未知操作" };
  }

  private resolvedCardFor(
    pending: PendingCard,
    resolution: "approved" | "rejected" | "self" | "revised",
  ): unknown {
    const taskId = pending.taskId;
    const title =
      pending.mode === "reply"
        ? pending.style === "detailed"
          ? "对方要求详细回答"
          : "代答"
        : `任务 ${taskId}`;
    const view = {
      taskId,
      planHash: pending.planHash,
      mode: pending.mode,
      title,
      summary: pending.draft ?? "（无草稿）",
      repo: "—",
      baseBranch: "—",
      targetBranch: "—",
      commands: [],
      risks: [],
      acceptanceCriteria: [],
      openQuestions: [],
      resolution,
    };
    const rendered = this.options.platform.renderApproval(view);
    return rendered.kind === "card" ? rendered.card : undefined;
  }

  private async cancelPendingNow(
    action: PlatformAction,
    pending: PendingCard,
  ): Promise<PlatformActionResult> {
    this.options.pending.delete(`${action.taskId}:reply`);
    await this.options.pending.flush();
    const task = await this.options.tasks.get(action.taskId);
    if (task && canTransition(task.state, "canceled")) {
      task.state = "canceled";
      task.updatedAt = Date.now();
      await this.options.tasks.save(task);
    }
    await this.options.audit.append({
      actor: action.actor,
      action: "question_cancelled",
      taskId: action.taskId,
      details: { messageId: pending.sourceMessageId },
    });
    return this.replyManagementResult("已取消草稿");
  }

  private pendingApprovalCard(pending: PendingCard, task?: TaskRecord): unknown {
    const view = {
      taskId: pending.taskId,
      planHash: pending.planHash,
      mode: "reply" as const,
      title:
        pending.style === "detailed"
          ? "对方要求详细回答，将给出完整信息"
          : "将用极简格式代答",
      summary: task?.title ?? pending.draft ?? "代答草稿",
      ...(pending.draft ? { draft: pending.draft } : {}),
      chatId: pending.chatId ?? "",
      sourceMessageId: pending.sourceMessageId ?? "",
      senderId: pending.actorId,
      repo: "—",
      baseBranch: "—",
      targetBranch: "—",
      commands: [],
      risks: ["代答会以机器人身份发送并标注（助手代答）"],
      acceptanceCriteria: ["引用原消息", "简洁回复，除非对方要求详细"],
      openQuestions: [],
    };
    const rendered = this.options.platform.renderApproval(view);
    return rendered.kind === "card" ? rendered.card : undefined;
  }

  async sendReplyManagementCard(withNames = true): Promise<boolean> {
    const ownerId = this.options.ownerOpenId();
    if (!ownerId) return false;
    const view = await this.replyManagementView(withNames);
    const message = this.options.platform.renderReplyManagement?.(view);
    if (!message) return false;
    try {
      await this.options.platform.send({ kind: "user", userId: ownerId }, message);
      return true;
    } catch (error) {
      this.options.logger.warn("failed to send reply management card", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private groupLabel(chatId: string | undefined): string {
    if (!chatId) return "未知群";
    return (
      this.options.config.platforms.feishu.groups.find((group) => group.chatId === chatId)?.name ??
      chatId
    );
  }

  private async replyManagementResult(toast: string): Promise<PlatformActionResult> {
    const view = await this.replyManagementView(false);
    const message = this.options.platform.renderReplyManagement?.(view);
    return {
      ok: true,
      toast,
      ...(message?.kind === "card" ? { card: message.card } : {}),
    };
  }

  private async resolveSenderLabel(value: string): Promise<string> {
    if (!/^ou_/.test(value)) return value;
    const cached = this.nameCache.get(value);
    if (cached) return cached;
    try {
      const name = await this.options.platform.fetchUserName?.(value);
      if (name) {
        this.nameCache.set(value, name);
        return name;
      }
    } catch {
      // Fall back to the open_id when contact lookup is unavailable.
    }
    return value;
  }

  private async replyManagementView(withNames = true): Promise<ReplyManagementView> {
    const pending: PendingReplySummary[] = [];
    const cards = this.options.pending
      .snapshot()
      .filter(([key, card]) => key.endsWith(":reply") && card.mode === "reply")
      .sort((a, b) => b[1].createdAt - a[1].createdAt);
    for (const [, card] of cards) {
      const task = await this.options.tasks.get(card.taskId);
      const sender = task?.requester.displayName ?? task?.requester.id ?? card.actorId;
      pending.push({
        taskId: card.taskId,
        planHash: card.planHash,
        chatLabel: task?.chatName ?? this.groupLabel(card.chatId),
        senderLabel: withNames ? await this.resolveSenderLabel(sender) : sender,
        draft: card.draft ?? "（无草稿）",
        excerpt: task?.excerpt ?? "",
        createdAt: card.createdAt,
      });
    }
    const sent = [];
    for (const item of this.options.sentReplies.listRecallable(8)) {
      sent.push({
        id: item.id,
        chatLabel: item.chatName ?? this.groupLabel(item.chatId),
        senderLabel: withNames ? await this.resolveSenderLabel(item.senderLabel) : item.senderLabel,
        text: item.text,
        sourceText: item.sourceText,
        sentAt: item.sentAt,
        status: item.status,
      });
    }
    return { pending, sent };
  }

  private async approveTask(action: PlatformAction): Promise<boolean> {
    const pending =
      this.options.pending.get(`${action.taskId}:develop`) ??
      this.options.pending.get(`${action.taskId}:reply`);
    if (!pending) return false;
    if (pending.mode === "reply") {
      return this.options.approveReply(action, pending);
    }
    const task = await this.options.tasks.get(action.taskId);
    if (!task) return false;
    assertTransition(task.state, "approved");
    task.state = "approved";
    task.updatedAt = Date.now();
    await this.options.tasks.save(task);
    await this.options.approvals.append({
      taskId: task.id,
      analysisVersion: pending.analysisVersion,
      planHash: pending.planHash,
      kind: "develop",
      decision: "approved",
      approvedBy: action.actor,
      decidedAt: Date.now(),
      createdAt: Date.now(),
    });
    await this.options.audit.append({
      actor: action.actor,
      action: "task_approved",
      taskId: task.id,
      details: { planHash: pending.planHash },
    });
    this.options.pending.deleteForTask(task.id);
    await this.options.pending.flush();
    this.options.startExecution(task, pending.planHash);
    return true;
  }

  private async rejectTask(action: PlatformAction): Promise<void> {
    const task = await this.options.tasks.get(action.taskId);
    if (!task) return;
    if (task.state !== "rejected" && canTransition(task.state, "rejected")) {
      task.state = "rejected";
      task.updatedAt = Date.now();
      await this.options.tasks.save(task);
    }
    this.options.pending.deleteForTask(task.id);
    await this.options.pending.flush();
    await this.options.audit.append({
      actor: action.actor,
      action: "task_rejected",
      taskId: task.id,
      details: {},
    });
  }
}
