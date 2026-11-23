import { canTransition } from "./task-state.js";
import { sha256, truncate } from "./util.js";
export class OwnerCommandService {
    options;
    constructor(options) {
        this.options = options;
    }
    async handle(message, command) {
        const ownerId = this.options.ownerOpenId();
        if (!ownerId)
            return "owner 未绑定，无法执行命令。";
        if (message.sender.id !== ownerId)
            return "无权操作。";
        if (command.command === "help") {
            return [
                "可用命令：",
                "/列表                  查看待审批代答",
                "/改写 <新内容>         替换最近一条草稿",
                "/重写 <要求>           重新生成最近一条草稿",
                "/发送                  发送最近一条草稿",
                "/取消 [编号|taskId]    取消指定或最近一条",
                "/回复管理              查看并撤回最近回复",
                "/职责 <群名|chatId> <说明>  设置群职责画像",
                "/工作空间 <群名|chatId> [root] 查看/设置工作空间",
                "/工作空间 <群名|chatId> 添加 <名称> <路径> [说明]",
                "/工作空间 <群名|chatId> 删除 <名称>",
                "/工作空间 <群名|chatId> 测试|检查 <名称> <命令>",
                "/工作空间 <群名|chatId> 自动 自动发现 worktrees 项目",
                "/方向 <群名|chatId> <说明> 设置我在该群的研发方向",
                "/关键词 <群名|chatId> <关键词1,关键词2> 设置我在该群的研发关键词",
                "/目标 [编号|chatId|messageId] 查看/选择私聊目标",
                "/画像 [群名|chatId]      查看群初始画像",
            ].join("\n");
        }
        if (command.command === "profile") {
            return this.options.getGroupKnowledge(command.arg);
        }
        if (command.command === "target") {
            return command.arg
                ? this.options.selectOwnerTarget(command.arg)
                : this.options.listOwnerTargets();
        }
        if (command.command === "responsibility") {
            if (!command.arg)
                return "用法：/职责 <群名|chatId> <职责说明>";
            return this.options.setGroupResponsibility(command.arg);
        }
        if (command.command === "workspace") {
            if (!command.arg)
                return "用法：/工作空间 <群名|chatId> [root|添加|删除|自动|清空]";
            return this.options.manageWorkspace(command.arg);
        }
        if (command.command === "direction") {
            return this.options.setOwnerFocus(command.arg, "direction");
        }
        if (command.command === "keywords") {
            return this.options.setOwnerFocus(command.arg, "keywords");
        }
        if (command.command === "replies") {
            const sent = await this.options.sendReplyManagementCard();
            return sent ? "已发送回复管理卡片。" : "回复管理卡片发送失败。";
        }
        const list = this.replyPendingList();
        if (command.command === "list") {
            if (list.length === 0)
                return "当前没有待处理的代答草稿。";
            const lines = ["待审批代答："];
            list.forEach(([, card], index) => {
                lines.push(`${index + 1}. ${card.taskId}  ${truncate(card.draft ?? "(无草稿)", 40)}`);
            });
            lines.push("用 /取消 <编号|taskId> 撤销指定草稿。");
            return lines.join("\n");
        }
        let target;
        if (command.command === "cancel" && command.arg) {
            target = this.resolveReplyPending(list, command.arg);
            if (!target)
                return "找不到指定的草稿，用 /列表 查看编号。";
        }
        else {
            target = list[0];
            if (!target)
                return "当前没有待处理的代答草稿。";
        }
        const [key, pending] = target;
        const task = await this.options.tasks.get(pending.taskId);
        if (command.command === "cancel") {
            this.options.pending.delete(key);
            await this.options.pending.flush();
            if (task && canTransition(task.state, "canceled")) {
                task.state = "canceled";
                task.updatedAt = Date.now();
                await this.options.tasks.save(task);
            }
            await this.options.audit.append({
                actor: message.sender,
                action: "question_cancelled",
                taskId: pending.taskId,
                details: { messageId: pending.sourceMessageId },
            });
            return `已取消 ${pending.taskId}，草稿不会发送。`;
        }
        if (command.command === "send") {
            const action = {
                platform: message.platform,
                actionId: `dm:${message.messageId}`,
                taskId: pending.taskId,
                planHash: pending.planHash,
                action: "approve",
                ...(pending.chatId ? { chatId: pending.chatId } : {}),
                ...(pending.sourceMessageId ? { messageId: pending.sourceMessageId } : {}),
                actor: message.sender,
            };
            const sent = await this.options.approveReply(action, pending);
            return sent ? "已按当前草稿发送到群里。" : "发送失败，草稿已保留。";
        }
        if (!command.arg) {
            return command.command === "rewrite" ? "用法：/改写 <新内容>" : "用法：/重写 <要求>";
        }
        let draft = command.arg;
        if (command.command === "regenerate") {
            const original = this.replyOriginal(pending, task);
            if (!original)
                return "缺少原消息，无法重写。";
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(new Error("rewrite timed out")), this.options.analysisTimeoutMs);
            try {
                draft = await this.options.askOpenCode({ ...original, text: `${original.text}\n\n请按以下要求重写：${command.arg}` }, pending.style ?? this.options.replyOptions.defaultStyle, controller.signal);
            }
            finally {
                clearTimeout(timer);
            }
        }
        const planHash = sha256(`${pending.taskId}:${pending.sourceMessageId}:${pending.style ?? ""}:${draft}`).slice(0, 16);
        const updated = { ...pending, draft, planHash, createdAt: Date.now() };
        this.options.pending.set(key, updated);
        await this.options.pending.flush();
        await this.resendReplyCard(updated, task);
        return command.command === "rewrite" ? "已更新草稿，审批卡已重发。" : "已重写并重发审批卡。";
    }
    replyPendingList() {
        return this.options.pending
            .snapshot()
            .filter(([key, card]) => key.endsWith(":reply") && card.mode === "reply")
            .sort((a, b) => b[1].createdAt - a[1].createdAt);
    }
    resolveReplyPending(list, arg) {
        const value = arg.trim();
        if (/^\d+$/.test(value))
            return list[Number(value) - 1];
        return list.find(([key, card]) => key === `${value}:reply` ||
            card.taskId === value ||
            card.taskId.endsWith(value));
    }
    replyOriginal(pending, task) {
        if (!pending.chatId || !pending.sourceMessageId)
            return undefined;
        return {
            platform: pending.platform,
            messageId: pending.sourceMessageId,
            chat: { id: pending.chatId, kind: "group" },
            sender: { platform: pending.platform, id: pending.actorId },
            senderType: "user",
            text: task?.excerpt ?? "",
            mentions: [],
            createdAt: task?.createdAt ?? Date.now(),
            rawType: "text",
        };
    }
    async resendReplyCard(pending, task) {
        const ownerId = this.options.ownerOpenId();
        if (!ownerId)
            throw new Error("owner is not bound; cannot send approval card");
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
        const outbound = this.options.platform.renderApproval(view);
        await this.options.sendLimiter.take();
        const result = await this.options.platform.send({ kind: "user", userId: ownerId }, outbound);
        this.options.pending.set(`${pending.taskId}:reply`, {
            ...pending,
            ...(result.messageId ? { messageId: result.messageId } : {}),
            createdAt: Date.now(),
        });
        await this.options.pending.flush();
    }
}
//# sourceMappingURL=owner-command-service.js.map