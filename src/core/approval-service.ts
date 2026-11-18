import type { AppConfig } from "./config.js";
import type { AuditLog } from "./audit.js";
import type { ApprovalStore } from "./approval-store.js";
import type { Logger } from "./logger.js";
import type { PendingStore } from "./pending-store.js";
import type { PendingCard } from "./pending-store.js";
import type { PlatformAdapter } from "./ports.js";
import type { TaskStore } from "./task-store.js";
import type {
  PlatformAction,
  PlatformActionResult,
  TaskRecord,
} from "./types.js";
import { assertTransition, canTransition } from "./task-state.js";
import type { ExecutionActions, Notifier, ReplyActions } from "./runtime-ports.js";

export interface ApprovalServiceOptions {
  config: AppConfig;
  pending: PendingStore;
  tasks: TaskStore;
  approvals: ApprovalStore;
  audit: AuditLog;
  platform: PlatformAdapter;
  logger: Logger;
  ownerOpenId(): string | undefined;
  notifier: Notifier;
  replyActions: ReplyActions;
  executionActions: ExecutionActions;
}

export class ApprovalService {
  constructor(private readonly options: ApprovalServiceOptions) {}

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
      await this.options.notifier.send(`审批已超时：${task?.title ?? card.taskId}`);
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
      await this.approveTask(action);
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

  private async approveTask(action: PlatformAction): Promise<void> {
    const pending =
      this.options.pending.get(`${action.taskId}:develop`) ??
      this.options.pending.get(`${action.taskId}:reply`);
    if (!pending) return;
    if (pending.mode === "reply") {
      await this.options.replyActions.approve(action, pending);
      return;
    }
    const task = await this.options.tasks.get(action.taskId);
    if (!task) return;
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
    this.options.executionActions.start(task, pending.planHash);
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
