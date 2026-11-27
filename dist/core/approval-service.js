import { assertTransition, canTransition } from "./task-state.js";
import { sha256, toErrorMessage } from "./util.js";
export class ApprovalService {
    options;
    constructor(options) {
        this.options = options;
    }
    inflight = new Set();
    nameCache = new Map();
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
            return (await this.sendReplyManagementCard(false))
                ? { ok: true, toast: "回复管理已发送" }
                : { ok: false, toast: "回复管理卡片发送失败" };
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
            if (!pending)
                return { ok: false, toast: "草稿不存在或已处理" };
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
            if (!pending)
                return { ok: false, toast: "草稿不存在或已处理" };
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
            const task = await this.options.tasks.findByMessageId(record.sourceMessageId);
            if (task) {
                task.state = "awaiting_approval";
                task.updatedAt = Date.now();
                await this.options.tasks.save(task);
                await this.restorePendingDraft(task, record);
                await this.options.sendToApprover(`已撤回机器人回复，原任务已重新打开：
群：${this.groupLabel(task.chatId)}
${task.title}
草稿已放回待审批：/改写 <新内容>、/重写 <要求>，或 /发送 重新发送。`);
            }
            await this.options.audit.append({
                actor: action.actor,
                action: "reply_recalled",
                details: {
                    messageId: record.sentMessageId,
                    chatId: record.chatId,
                    ...(task ? { taskId: task.id } : {}),
                },
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
        const fallbackTitle = pending.mode === "reply"
            ? pending.style === "detailed"
                ? "对方要求详细回答"
                : "代答"
            : `任务 ${taskId}`;
        const view = {
            ...(pending.view ?? {
                taskId,
                planHash: pending.planHash,
                mode: pending.mode,
                title: fallbackTitle,
                summary: pending.draft ?? "（无草稿）",
                repo: "—",
                baseBranch: "—",
                targetBranch: "—",
                commands: [],
                risks: [],
                acceptanceCriteria: [],
                openQuestions: [],
            }),
            taskId,
            planHash: pending.planHash,
            mode: pending.mode,
            resolution,
        };
        const rendered = this.options.platform.renderApproval(view);
        return rendered.kind === "card" ? rendered.card : undefined;
    }
    async cancelPendingNow(action, pending) {
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
    pendingApprovalCard(pending, task) {
        const view = {
            taskId: pending.taskId,
            planHash: pending.planHash,
            mode: "reply",
            title: pending.style === "detailed"
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
    async sendReplyManagementCard(withNames = true) {
        const ownerId = this.options.ownerOpenId();
        if (!ownerId)
            return false;
        const view = await this.replyManagementView(withNames);
        const message = this.options.platform.renderReplyManagement?.(view);
        if (!message)
            return false;
        try {
            await this.options.platform.send({ kind: "user", userId: ownerId }, message);
            return true;
        }
        catch (error) {
            this.options.logger.warn("failed to send reply management card", {
                error: error instanceof Error ? error.message : String(error),
            });
            return false;
        }
    }
    groupLabel(chatId) {
        if (!chatId)
            return "未知群";
        const name = this.options.config.platforms.feishu.groups.find((group) => group.chatId === chatId)?.name;
        if (name)
            return name;
        return /^oc_/.test(chatId) ? "未知群" : chatId;
    }
    async replyManagementResult(toast) {
        const view = await this.replyManagementView(false);
        const message = this.options.platform.renderReplyManagement?.(view);
        return {
            ok: true,
            toast,
            ...(message?.kind === "card" ? { card: message.card } : {}),
        };
    }
    async resolveSenderLabel(value, sourceMessageId) {
        if (!/^ou_/.test(value))
            return value;
        const cached = this.nameCache.get(value);
        if (cached)
            return cached;
        try {
            const name = await this.options.platform.fetchUserName?.(value);
            if (name) {
                this.nameCache.set(value, name);
                return name;
            }
        }
        catch (error) {
            this.options.logger.warn("sender name lookup failed", {
                senderId: value,
                error: toErrorMessage(error),
            });
        }
        if (sourceMessageId) {
            try {
                const message = await this.options.platform.fetchMessage?.(sourceMessageId);
                const name = message?.sender.displayName;
                if (name) {
                    this.nameCache.set(value, name);
                    return name;
                }
            }
            catch (error) {
                this.options.logger.warn("source message sender name lookup failed", {
                    senderId: value,
                    sourceMessageId,
                    error: toErrorMessage(error),
                });
            }
        }
        this.options.logger.warn("sender name unavailable; using placeholder", {
            senderId: value,
            sourceMessageId,
        });
        return "未知成员";
    }
    async restorePendingDraft(task, record) {
        if (this.options.pending.get(`${task.id}:reply`) || this.options.pending.findForTask(task.id)) {
            return;
        }
        const draft = record.text.replace(/^（助手代答）\s*/, "").trim();
        const planHash = sha256(`${task.id}:${record.sourceMessageId}:concise:${draft}`).slice(0, 16);
        this.options.pending.set(`${task.id}:reply`, {
            platform: record.platform,
            taskId: task.id,
            planHash,
            analysisVersion: 1,
            actorId: task.requester.id,
            mode: "reply",
            chatId: record.chatId,
            sourceMessageId: record.sourceMessageId,
            style: "concise",
            draft,
            createdAt: Date.now(),
        });
        await this.options.pending.flush();
    }
    async restoreRecalledDrafts() {
        let changed = false;
        for (const record of this.options.sentReplies.list(50)) {
            if (record.status !== "recalled")
                continue;
            const task = await this.options.tasks.findByMessageId(record.sourceMessageId);
            if (!task)
                continue;
            if (this.options.pending.get(`${task.id}:reply`) || this.options.pending.findForTask(task.id)) {
                continue;
            }
            task.state = "awaiting_approval";
            task.updatedAt = Date.now();
            await this.options.tasks.save(task);
            await this.restorePendingDraft(task, record);
            changed = true;
        }
        if (changed)
            await this.options.pending.flush();
    }
    async replyManagementView(withNames = true) {
        await this.restoreRecalledDrafts();
        const pending = [];
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
                chatLabel: task?.chatName && task.chatName !== task.chatId
                    ? task.chatName
                    : this.groupLabel(task?.chatId ?? card.chatId),
                senderLabel: withNames
                    ? await this.resolveSenderLabel(sender, card.sourceMessageId)
                    : /^ou_/.test(sender)
                        ? "未知成员"
                        : sender,
                draft: card.draft ?? "（无草稿）",
                excerpt: task?.excerpt ?? "",
                createdAt: card.createdAt,
            });
        }
        const sent = [];
        for (const item of this.options.sentReplies.listRecallable(8)) {
            sent.push({
                id: item.id,
                chatLabel: item.chatName && item.chatName !== item.chatId
                    ? item.chatName
                    : this.groupLabel(item.chatId),
                senderLabel: withNames
                    ? await this.resolveSenderLabel(item.senderLabel, item.sourceMessageId)
                    : /^ou_/.test(item.senderLabel)
                        ? "未知成员"
                        : item.senderLabel,
                text: item.text,
                sourceText: item.sourceText,
                sentAt: item.sentAt,
                status: item.status,
            });
        }
        return { pending, sent };
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