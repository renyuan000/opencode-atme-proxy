import { truncate, truncateMiddle } from "./util.js";
import { inspectUntrusted } from "./security.js";
export class ContextService {
    options;
    constructor(options) {
        this.options = options;
    }
    memoryBlock(platform, chatId, text) {
        const { config, memory } = this.options;
        if (!config.memory.enabled)
            return "";
        const records = memory.query({
            platform,
            ...(chatId ? { chatId } : {}),
            text,
            limit: config.memory.injectLimit,
        });
        if (records.length === 0)
            return "";
        const lines = records.map((record) => `- [${record.kind}${record.pinned ? ",pin" : ""}] ${record.key}: ${record.value}`);
        return truncate(["已知关键信息（优先参考，与当前消息冲突时以当前消息为准）：", ...lines].join("\n"), config.memory.injectMaxChars);
    }
    summaryText(platform, chatId) {
        const summary = this.options.groupContext.get(`${platform}:${chatId}`);
        if (!summary)
            return "";
        const parts = [
            summary.summary,
            ...summary.decisions.map((item) => `决策：${item}`),
            ...summary.assumptions.map((item) => `假设：${item}`),
            ...summary.openQuestions.map((item) => `未解决：${item}`),
            ...(summary.topics ?? []).map((topic) => `主题：${topic.title}${topic.phase ? `（${topic.phase}）` : ""}${topic.status !== "active" ? `[${topic.status}]` : ""}${topic.summary ? `：${topic.summary}` : ""}`),
        ].filter(Boolean);
        return truncateMiddle(parts.join("\n"), this.options.config.groupSession?.summaryMaxChars ?? 1500);
    }
    quotedContext(message) {
        if (!message.replyToMessageId && !message.threadId)
            return [];
        const chatKey = `${message.platform}:${message.chat.id}`;
        const lines = [];
        if (message.replyToMessageId) {
            const [quoted] = this.options.chatContext.find(chatKey, [message.replyToMessageId]);
            if (quoted) {
                lines.push(`- ${quoted.senderName ?? quoted.senderId}: ${truncateMiddle(quoted.text, 500)}`);
            }
            else {
                const evidence = this.options.evidence.findByMessageId({
                    chatId: message.chat.id,
                    messageId: message.replyToMessageId,
                });
                if (evidence) {
                    lines.push(`- ${evidence.senderName ?? evidence.senderId ?? "未知"}: ${truncateMiddle(evidence.text, 500)}`);
                }
            }
        }
        if (message.threadId) {
            const thread = this.options.chatContext
                .recent(chatKey, 50)
                .filter((item) => item.threadId === message.threadId && item.messageId !== message.messageId)
                .slice(-5);
            for (const item of thread) {
                lines.push(`- [同线程] ${item.senderName ?? item.senderId}: ${truncateMiddle(item.text, 300)}`);
            }
        }
        return lines;
    }
    evidenceRecall(message) {
        const { config, chatContext, evidence } = this.options;
        if (config.evidence?.enabled === false)
            return [];
        const text = message.text.trim();
        const referential = text.length <= 20 ||
            /(哪个|这个|那个|上面|之前|上次|刚才|继续|那条|第.步)/.test(text);
        if (!referential && !message.replyToMessageId)
            return [];
        const quoted = this.quotedContext(message).join(" ");
        const split = (value) => value
            .split(/[\s,，。；;、:：!！?？]+/)
            .map((item) => item.trim())
            .filter((item) => item.length >= 2);
        let terms = split(`${quoted} ${text}`).slice(0, 8);
        if (terms.length === 0) {
            const recent = chatContext
                .recent(`${message.platform}:${message.chat.id}`, 3, message.messageId)
                .map((item) => item.text)
                .join(" ");
            terms = split(recent).slice(0, 8);
        }
        if (terms.length === 0)
            return [];
        return evidence
            .search({ chatId: message.chat.id, terms, days: 7, limit: 5 })
            .filter((record) => record.messageId !== message.messageId)
            .map((record) => `- ${new Date(record.ts).toLocaleString()} ${record.senderName ?? record.senderId ?? ""}: ${truncateMiddle(record.text, 200)}`);
    }
    async ownerOverview(message) {
        const { config, memory, tasks, groupContext } = this.options;
        const groups = config.platforms.feishu.groups;
        const names = new Map(groups.map((group) => [group.chatId, group.name ?? group.chatId]));
        const summaries = (groupContext.list?.() ?? [])
            .filter((item) => item.summary.trim())
            .slice(0, 2)
            .map((item) => {
            const chatId = item.chatId.split(":").pop() ?? item.chatId;
            return `【${names.get(chatId) ?? chatId}】${item.summary}`;
        });
        const allTasks = tasks.list ? await tasks.list() : [];
        const openTasks = allTasks
            .filter((task) => !task.archivedAt && ["candidate", "analyzing", "needs_info", "awaiting_approval"].includes(task.state))
            .slice(0, 5)
            .map((task) => `- ${names.get(task.chatId) ?? task.chatName ?? task.chatId}: ${task.title} [${task.state}]`);
        const records = config.memory.enabled
            ? memory.query({ platform: message.platform, text: message.text, limit: config.memory.injectLimit })
            : [];
        const memoryItems = records.slice(0, 8).map((record) => `- [${record.kind}${record.pinned ? ",pin" : ""}] ${record.key}: ${record.value}`);
        const blocks = [
            ...(summaries.length > 0 ? ["群摘要（跨群，仅供主人参考）：", ...summaries] : []),
            ...(openTasks.length > 0 ? ["未关闭任务（跨群）：", ...openTasks] : []),
            ...(memoryItems.length > 0 ? ["相关群记忆：", ...memoryItems] : []),
        ];
        return truncate(blocks.join("\n"), 2200);
    }
    async analysisContext(task) {
        const { config, chatContext, memory, tasks } = this.options;
        const chatKey = `${task.platform}:${task.chatId}`;
        const source = config.context.enabled
            ? chatContext.find(chatKey, task.messageIds ?? [])
            : [];
        const recent = config.context.enabled && config.context.includeInAnalysis
            ? chatContext.recent(chatKey, 12)
            : [];
        const records = config.memory.enabled
            ? memory.query({
                platform: task.platform,
                chatId: task.chatId,
                text: `${task.title} ${task.excerpt}`,
                limit: config.memory.injectLimit,
            })
            : [];
        const format = (record) => `${record.kind}${record.pinned ? "/pin" : ""}: ${record.key} = ${record.value}`;
        const sourceMessages = source.map((item) => `${item.senderName ?? item.senderId}: ${truncateMiddle(item.text, 400)}`);
        const supplements = (task.supplements ?? []).map((item) => `${item.senderName ?? item.senderId ?? "owner"}: ${truncateMiddle(item.text, 400)}`);
        const recentContext = recent.map((item) => `${item.senderName ?? item.senderId}: ${truncateMiddle(item.text, 300)}`);
        const pinned = records.filter((record) => record.pinned).map(format);
        const memoryItems = records.filter((record) => !record.pinned).map(format);
        const openTasks = (await tasks.list())
            .filter((item) => item.platform === task.platform &&
            item.chatId === task.chatId &&
            item.id !== task.id &&
            !item.archivedAt &&
            ["candidate", "analyzing", "needs_info", "awaiting_approval"].includes(item.state))
            .slice(0, 5)
            .map((item) => `${item.id} ${item.title} [${item.state}]`);
        const summary = this.summaryText(task.platform, task.chatId);
        const security = inspectUntrusted([task.excerpt, ...sourceMessages, ...recentContext].join("\n"));
        return {
            sourceMessages,
            supplements,
            recentContext,
            pinned,
            memory: memoryItems,
            openTasks,
            summary,
            security,
            corpus: [
                task.title,
                task.excerpt,
                ...(task.messageIds ?? []),
                ...sourceMessages,
                ...supplements,
                ...recentContext,
                ...pinned,
                ...memoryItems,
                ...openTasks,
                summary,
            ].join("\n"),
        };
    }
}
//# sourceMappingURL=context-service.js.map