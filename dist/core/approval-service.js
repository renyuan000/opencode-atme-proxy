import { assertTransition, canTransition } from "./task-state.js";
export class ApprovalService {
    options;
    constructor(options) {
        this.options = options;
    }
    inflight = new Set();
    async sweepExpiredApprovals() {
        const ttlMs = this.options.config.policy.approvalTimeoutHours * 3600_000;
        const now = Date.now();
        for (const [key, card] of this.options.pending.snapshot()) {
            if (now - card.createdAt < ttlMs)
                continue;
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
    async isAuthorizedActor(actor) {
        const ownerId = this.options.ownerOpenId();
        if (ownerId && actor.id === ownerId)
            return true;
        if (this.options.config.platforms.feishu.approvers.some((approver) => approver.openId === actor.id)) {
            return true;
        }
        return this.options.platform.verifyActor(actor);
    }
    async onAction(action) {
        if (action.action === "reply_manage") {
            return this.handleAction(action);
        }
        const key = action.action === "recall_reply"
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
        }
        finally {
            this.inflight.delete(key);
        }
    }
    async handleAction(action) {
        if (action.action === "reply_manage") {
            if (!(await this.isAuthorizedActor(action.actor))) {
                return { ok: false, toast: "无权操作" };
            }
            return this.sendReplyManagementCard();
        }
        if (action.action === "cancel_pending") {
            if (!(await this.isAuthorizedActor(action.actor))) {
                return { ok: false, toast: "无权操作" };
            }
            const pending = this.options.pending.get(`${action.taskId}:reply`);
            if (!pending)
                return { ok: false, toast: "草稿不存在或已处理" };
            if (action.planHash && action.planHash !== pending.planHash) {
                return { ok: false, toast: "草稿已变更，请刷新列表" };
            }
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
        if (action.action === "recall_reply") {
            if (!(await this.isAuthorizedActor(action.actor))) {
                return { ok: false, toast: "无权操作" };
            }
            if (!action.replyId)
                return { ok: false, toast: "缺少回复标识" };
            const record = this.options.sentReplies.get(action.replyId);
            if (!record)
                return { ok: false, toast: "找不到这条回复" };
            if (record.status === "recalled") {
                return this.replyManagementResult("该回复已撤回");
            }
            if (!this.options.platform.recallMessage) {
                return { ok: false, toast: "当前平台不支持撤回" };
            }
            try {
                await this.options.platform.recallMessage(record.chatId, record.sentMessageId);
            }
            catch (error) {
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
        const pending = this.options.pending.get(`${action.taskId}:develop`) ??
            this.options.pending.get(`${action.taskId}:reply`);
        if (!pending)
            return { ok: false, toast: "任务不存在或已处理" };
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
    resolvedCardFor(pending, resolution) {
        const taskId = pending.taskId;
        const title = pending.mode === "reply"
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
    async sendReplyManagementCard() {
        const ownerId = this.options.ownerOpenId();
        if (!ownerId)
            return { ok: false, toast: "owner 未绑定" };
        const view = await this.replyManagementView();
        const message = this.options.platform.renderReplyManagement?.(view);
        if (!message)
            return { ok: false, toast: "当前平台不支持回复管理卡片" };
        try {
            await this.options.platform.send({ kind: "user", userId: ownerId }, message);
            return { ok: true, toast: "回复管理已发送" };
        }
        catch (error) {
            this.options.logger.warn("failed to send reply management card", {
                error: error instanceof Error ? error.message : String(error),
            });
            return { ok: false, toast: "回复管理卡片发送失败" };
        }
    }
    async replyManagementResult(toast) {
        const view = await this.replyManagementView();
        const message = this.options.platform.renderReplyManagement?.(view);
        return {
            ok: true,
            toast,
            ...(message?.kind === "card" ? { card: message.card } : {}),
        };
    }
    async replyManagementView() {
        const pending = [];
        const cards = this.options.pending
            .snapshot()
            .filter(([key, card]) => key.endsWith(":reply") && card.mode === "reply")
            .sort((a, b) => b[1].createdAt - a[1].createdAt);
        for (const [, card] of cards) {
            const task = await this.options.tasks.get(card.taskId);
            pending.push({
                taskId: card.taskId,
                planHash: card.planHash,
                chatLabel: task?.chatName ?? card.chatId ?? "未知群",
                senderLabel: task?.requester.displayName ?? task?.requester.id ?? card.actorId,
                draft: card.draft ?? "（无草稿）",
                excerpt: task?.excerpt ?? "",
                createdAt: card.createdAt,
            });
        }
        return {
            pending,
            sent: this.options.sentReplies.listRecallable(5).map((item) => ({
                id: item.id,
                chatLabel: item.chatName ?? item.chatId,
                senderLabel: item.senderLabel,
                text: item.text,
                sourceText: item.sourceText,
                sentAt: item.sentAt,
                status: item.status,
            })),
        };
    }
    async approveTask(action) {
        const pending = this.options.pending.get(`${action.taskId}:develop`) ??
            this.options.pending.get(`${action.taskId}:reply`);
        if (!pending)
            return false;
        if (pending.mode === "reply") {
            return this.options.approveReply(action, pending);
        }
        const task = await this.options.tasks.get(action.taskId);
        if (!task)
            return false;
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
    async rejectTask(action) {
        const task = await this.options.tasks.get(action.taskId);
        if (!task)
            return;
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
//# sourceMappingURL=approval-service.js.map