import * as Lark from "@larksuiteoapi/node-sdk";
import { createLogger } from "../../core/logger.js";
import { toErrorMessage } from "../../core/util.js";
export function mapFeishuMessage(raw) {
    const messageId = raw.message_id;
    const chatId = raw.chat_id;
    if (!messageId || !chatId)
        return undefined;
    const senderId = raw.sender?.sender_id?.open_id ?? raw.sender?.sender_id?.user_id ?? "unknown";
    const senderType = normalizeSenderType(raw.sender?.sender_type);
    const mentions = (raw.mentions ?? []).map((mention) => ({
        platform: "feishu",
        id: mention.id?.open_id ?? mention.id?.user_id ?? mention.id?.union_id ?? "",
        ...(mention.name ? { displayName: mention.name } : {}),
    }));
    const text = extractText(raw, mentions);
    const attachments = extractAttachments(raw);
    return {
        platform: "feishu",
        messageId,
        chat: {
            id: chatId,
            kind: raw.chat_type === "p2p" ? "direct" : "group",
        },
        sender: {
            platform: "feishu",
            id: senderId,
        },
        senderType,
        text,
        mentions,
        ...(raw.parent_id ? { replyToMessageId: raw.parent_id } : {}),
        ...(raw.root_id ?? raw.thread_id ? { threadId: raw.root_id ?? raw.thread_id } : {}),
        createdAt: Number(raw.create_time ?? Date.now()),
        rawType: raw.message_type ?? "unknown",
        ...(attachments.length > 0 ? { attachments } : {}),
    };
}
function normalizeSenderType(value) {
    if (value === "bot" || value === "app")
        return "bot";
    if (value === "system")
        return "system";
    return "user";
}
function extractText(raw, mentions) {
    const type = raw.message_type ?? "";
    if (!raw.content)
        return type ? `[${type}]` : "";
    if (type === "image")
        return "[图片，未解析]";
    if (type === "file")
        return "[文件，未解析]";
    if (type === "audio")
        return "[音频，未解析]";
    if (type === "media" || type === "video")
        return "[视频，未解析]";
    if (type !== "text" && type !== "post")
        return `[${type}]`;
    try {
        const parsed = JSON.parse(raw.content);
        let text = typeof parsed.text === "string" ? parsed.text : "";
        if (!text && typeof parsed.content === "string")
            text = parsed.content;
        if (!text && Array.isArray(parsed.content)) {
            text = extractPostText(parsed.content);
        }
        const rawMentions = raw.mentions ?? [];
        for (const mention of rawMentions) {
            const key = mention.key;
            if (key && mention.name) {
                text = text.replace(new RegExp(escapeRegExp(key), "g"), `@${mention.name}`);
            }
        }
        return text.trim() || (type ? `[${type}]` : "");
    }
    catch {
        return type ? `[${type}]` : "";
    }
}
function extractPostText(content) {
    const parts = [];
    for (const block of content) {
        if (!Array.isArray(block))
            continue;
        for (const item of block) {
            if (!item || typeof item !== "object")
                continue;
            const record = item;
            if (typeof record.text === "string") {
                parts.push(record.text);
                continue;
            }
            if (record.tag === "img") {
                const width = typeof record.width === "number" ? record.width : undefined;
                const height = typeof record.height === "number" ? record.height : undefined;
                parts.push(width && height ? `[图片 ${width}x${height}，未解析]` : "[图片，未解析]");
                continue;
            }
            if (record.tag === "media") {
                parts.push("[视频，未解析]");
                continue;
            }
            if (record.tag === "file") {
                const name = typeof record.file_name === "string" ? record.file_name : "";
                parts.push(name ? `[文件 ${name}，未解析]` : "[文件，未解析]");
            }
        }
    }
    return parts.join("");
}
function extractAttachments(raw) {
    const type = raw.message_type ?? "";
    if (!raw.content)
        return [];
    try {
        const parsed = JSON.parse(raw.content);
        if (type === "image") {
            const key = typeof parsed.image_key === "string" ? parsed.image_key : undefined;
            return [{ kind: "image", ...(key ? { key } : {}) }];
        }
        if (type === "file") {
            const key = typeof parsed.file_key === "string" ? parsed.file_key : undefined;
            const name = typeof parsed.file_name === "string" ? parsed.file_name : undefined;
            return [{ kind: "file", ...(key ? { key } : {}), ...(name ? { name } : {}) }];
        }
        if (type === "audio")
            return [{ kind: "audio" }];
        if (type === "media" || type === "video")
            return [{ kind: "video" }];
        if (type === "post" && Array.isArray(parsed.content)) {
            const result = [];
            for (const block of parsed.content) {
                if (!Array.isArray(block))
                    continue;
                for (const item of block) {
                    if (!item || typeof item !== "object")
                        continue;
                    const record = item;
                    if (record.tag === "img") {
                        const key = typeof record.image_key === "string" ? record.image_key : undefined;
                        result.push({ kind: "image", ...(key ? { key } : {}) });
                    }
                    else if (record.tag === "file") {
                        const key = typeof record.file_key === "string" ? record.file_key : undefined;
                        const name = typeof record.file_name === "string" ? record.file_name : undefined;
                        result.push({ kind: "file", ...(key ? { key } : {}), ...(name ? { name } : {}) });
                    }
                }
            }
            return result;
        }
    }
    catch {
        return [];
    }
    return [];
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
export class FeishuAdapter {
    options;
    platform = "feishu";
    logger;
    client;
    botOpenId;
    handlers;
    constructor(options) {
        this.options = options;
        this.logger = options.logger ?? createLogger({ scope: "feishu" });
        this.client = options.client ?? createLarkClient(options.config, options.appSecret);
    }
    capabilities() {
        return {
            realtimeMentions: true,
            allGroupMessages: this.options.config.receiveAllGroupMessages,
            groupHistory: true,
            directMessage: true,
            reply: true,
            interactiveCard: true,
            buttons: true,
            threads: false,
            attachmentsInbound: true,
            identityVerify: true,
        };
    }
    async start(handlers) {
        this.handlers = handlers;
        await this.resolveBotOpenId();
    }
    async stop() {
        this.handlers = undefined;
    }
    async healthCheck() {
        try {
            const response = await this.client.request({ method: "GET", url: "/open-apis/bot/v3/info" });
            return { ok: response?.code === 0, detail: response?.msg };
        }
        catch (error) {
            return { ok: false, detail: toErrorMessage(error) };
        }
    }
    getBotOpenId() {
        return this.botOpenId;
    }
    async listGroups() {
        const groups = [];
        let pageToken;
        do {
            const response = await this.client.request({
                method: "GET",
                url: "/open-apis/im/v1/chats",
                params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
            });
            if (response?.code !== 0) {
                throw new Error(`Feishu chat list failed: ${response?.msg ?? "unknown"}`);
            }
            const items = Array.isArray(response?.data?.items) ? response.data.items : [];
            for (const item of items) {
                if (typeof item?.chat_id === "string" && item.chat_id) {
                    groups.push({
                        chatId: item.chat_id,
                        ...(typeof item.name === "string" ? { name: item.name } : {}),
                    });
                }
            }
            pageToken = response?.data?.has_more ? response.data.page_token : undefined;
        } while (pageToken);
        return groups;
    }
    async listMessages(input) {
        const messages = [];
        let pageToken = input.cursor;
        for (let page = 0; page < input.maxPages; page++) {
            const response = await this.client.request({
                method: "GET",
                url: "/open-apis/im/v1/messages",
                params: {
                    container_id_type: "chat",
                    container_id: input.chatId,
                    start_time: String(Math.floor(input.startTime / 1000)),
                    end_time: String(Math.floor(input.endTime / 1000)),
                    sort_type: "ByCreateTimeAsc",
                    page_size: 50,
                    ...(pageToken ? { page_token: pageToken } : {}),
                },
            });
            if (response?.code !== 0) {
                throw new Error(`Feishu listMessages failed: ${response?.msg ?? "unknown"}`);
            }
            const items = Array.isArray(response?.data?.items) ? response.data.items : [];
            for (const item of items) {
                const mapped = mapFeishuMessage(item);
                if (mapped)
                    messages.push(mapped);
                if (messages.length >= input.maxMessages)
                    break;
            }
            if (messages.length >= input.maxMessages)
                break;
            if (!response?.data?.has_more)
                break;
            pageToken = response?.data?.page_token;
            if (!pageToken)
                break;
        }
        return { messages, ...(pageToken ? { nextCursor: pageToken } : {}) };
    }
    async send(target, message) {
        const receiveIdType = target.kind === "chat" ? "chat_id" : "open_id";
        const receiveId = target.kind === "chat" ? target.chatId : target.userId;
        const response = await this.client.request({
            method: "POST",
            url: "/open-apis/im/v1/messages",
            params: { receive_id_type: receiveIdType },
            data: toFeishuPayload(receiveId, message),
        });
        return this.requireMessageId(response, "send");
    }
    async reply(target, message) {
        const response = await this.client.request({
            method: "POST",
            url: `/open-apis/im/v1/messages/${encodeURIComponent(target.messageId)}/reply`,
            data: toFeishuPayload(undefined, message),
        });
        return this.requireMessageId(response, "reply");
    }
    renderApproval(view) {
        return renderApprovalCard(view);
    }
    renderReplyManagement(view) {
        return renderReplyManagementCard(view);
    }
    renderCancelConfirm(input) {
        return renderCancelConfirmCard(input);
    }
    async recallMessage(_chatId, messageId) {
        const response = await this.client.request({
            method: "DELETE",
            url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
        });
        if (response?.code !== 0) {
            throw new Error(`Feishu recall failed: ${response?.msg ?? "unknown"}`);
        }
    }
    async fetchResource(messageId, key, kind = "image") {
        const resource = this.client.im?.v1?.messageResource;
        if (!resource || typeof resource.get !== "function") {
            throw new Error("Feishu SDK does not expose messageResource.get");
        }
        let response;
        try {
            response = await resource.get({
                params: { type: kind },
                path: { message_id: messageId, file_key: key },
            });
        }
        catch (error) {
            const httpError = error;
            this.logger.warn("Feishu resource download failed", {
                messageId,
                fileKey: key,
                status: httpError.response?.status,
                code: httpError.response?.data?.code,
                msg: httpError.response?.data?.msg,
                error: toErrorMessage(error),
            });
            throw error;
        }
        const stream = response?.getReadableStream?.();
        if (!stream)
            throw new Error("Feishu resource response has no stream");
        const chunks = [];
        let total = 0;
        for await (const chunk of stream) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            total += buffer.length;
            if (total > 8 * 1024 * 1024) {
                throw new Error("image exceeds 8MB limit");
            }
            chunks.push(buffer);
        }
        const headerType = response?.headers?.["content-type"] ?? response?.headers?.["Content-Type"];
        const mime = typeof headerType === "string" && headerType.startsWith("image/")
            ? headerType.split(";")[0]
            : "image/png";
        return { data: Buffer.concat(chunks), mime };
    }
    async verifyActor(actor) {
        if (actor.platform !== "feishu")
            return false;
        return this.options.config.approvers.some((approver) => approver.openId === actor.id);
    }
    async acknowledge(messageId, emojiType = "OK") {
        const response = await this.client.request({
            method: "POST",
            url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
            data: { reaction_type: { emoji_type: emojiType } },
        });
        if (response?.code !== 0) {
            throw new Error(`Feishu reaction failed: ${response?.msg ?? "unknown"}`);
        }
    }
    requireMessageId(response, operation) {
        if (response?.code !== 0) {
            throw new Error(`Feishu ${operation} failed: ${response?.msg ?? "unknown"}`);
        }
        const messageId = response?.data?.message_id;
        if (typeof messageId !== "string" || !messageId) {
            throw new Error(`Feishu ${operation} returned no message_id`);
        }
        return { messageId };
    }
    async resolveBotOpenId() {
        if (this.options.config.botOpenId) {
            this.botOpenId = this.options.config.botOpenId;
            return;
        }
        try {
            const response = await this.client.request({ method: "GET", url: "/open-apis/bot/v3/info" });
            const openId = response?.bot?.open_id ?? response?.data?.bot?.open_id;
            if (typeof openId === "string") {
                this.botOpenId = openId;
            }
            else {
                this.logger.warn("bot open_id not found in /bot/v3/info response");
            }
        }
        catch (error) {
            this.logger.warn("failed to resolve bot open_id", { error: toErrorMessage(error) });
        }
    }
}
function toFeishuPayload(receiveId, message) {
    const uuid = message.uuid;
    if (message.kind === "text") {
        const mentions = (message.mentions ?? []).filter((mention) => mention.id);
        const atTags = mentions
            .map((mention) => `<at user_id="${mention.id}">${mention.name ?? ""}</at>`)
            .join(" ");
        const text = atTags ? `${atTags} ${message.text}` : message.text;
        return {
            ...(receiveId ? { receive_id: receiveId } : {}),
            ...(uuid ? { uuid } : {}),
            msg_type: "text",
            content: JSON.stringify({ text }),
        };
    }
    if (message.kind === "menu") {
        const lines = [message.text, ...message.options.map((option, index) => `${index + 1}. ${option.label}`)];
        return {
            ...(receiveId ? { receive_id: receiveId } : {}),
            ...(uuid ? { uuid } : {}),
            msg_type: "text",
            content: JSON.stringify({ text: lines.join("\n") }),
        };
    }
    return {
        ...(receiveId ? { receive_id: receiveId } : {}),
        ...(uuid ? { uuid } : {}),
        msg_type: "interactive",
        content: JSON.stringify(message.card),
    };
}
function buttonState(resolved, base) {
    if (!resolved)
        return base;
    return {
        ...base,
        type: "default",
        disabled: true,
        value: {},
    };
}
function resolutionLine(view) {
    if (!view.resolution)
        return "";
    const label = view.resolution === "approved"
        ? "已批准"
        : view.resolution === "rejected"
            ? "已拒绝"
            : view.resolution === "self"
                ? "已标记我自己回"
                : view.resolution === "revised"
                    ? "已请求修改"
                    : "已过期";
    return `\n**处理结果**：${label}${view.resolutionNote ? `（${view.resolutionNote}）` : ""}`;
}
export function renderApprovalCard(view) {
    const resolved = Boolean(view.resolution);
    if (view.mode === "reply") {
        return {
            kind: "card",
            card: {
                config: { wide_screen_mode: true },
                header: {
                    template: "blue",
                    title: {
                        tag: "plain_text",
                        content: resolved ? "已处理：代答审批" : "需要你确认：是否代答",
                    },
                },
                elements: [
                    {
                        tag: "div",
                        text: {
                            tag: "lark_md",
                            content: [
                                `**来源**：${view.summary}`,
                                ...(view.draft ? [`**拟回复**：${view.draft}`] : []),
                                `**方式**：${view.title}`,
                            ].join("\n") + resolutionLine(view),
                        },
                    },
                    {
                        tag: "action",
                        actions: [
                            buttonState(resolved, {
                                tag: "button",
                                text: { tag: "plain_text", content: "代答" },
                                type: "primary",
                                value: { a: "approve", t: view.taskId, h: view.planHash },
                            }),
                            buttonState(resolved, {
                                tag: "button",
                                text: { tag: "plain_text", content: "忽略" },
                                type: "default",
                                value: { a: "reject", t: view.taskId, h: view.planHash },
                            }),
                            buttonState(resolved, {
                                tag: "button",
                                text: { tag: "plain_text", content: "我自己回" },
                                type: "default",
                                value: { a: "self", t: view.taskId, h: view.planHash },
                            }),
                            {
                                tag: "button",
                                text: { tag: "plain_text", content: "回复管理" },
                                type: "default",
                                value: { a: "reply_manage", t: "__manage__" },
                            },
                        ],
                    },
                ],
            },
        };
    }
    const lines = [
        `**来源**：${view.summary}`,
        `**目标**：${view.title}`,
        `**仓库**：${view.repo}`,
        `**分支**：${view.baseBranch} → ${view.targetBranch}`,
        `**命令**：${view.commands.length > 0 ? view.commands.join("；") : "（无）"}`,
        `**风险**：${view.risks.length > 0 ? view.risks.join("；") : "（无）"}`,
        `**验收**：${view.acceptanceCriteria.length > 0 ? view.acceptanceCriteria.join("；") : "（未定义）"}`,
        `**计划哈希**：${view.planHash.slice(0, 8)}`,
    ];
    if (view.openQuestions.length > 0) {
        lines.push(`**待确认**：${view.openQuestions.join("；")}`);
    }
    return {
        kind: "card",
        card: {
            config: { wide_screen_mode: true },
            header: {
                template: "blue",
                title: {
                    tag: "plain_text",
                    content: resolved ? `已处理：${view.title}` : `任务待批准：${view.title}`,
                },
            },
            elements: [
                { tag: "div", text: { tag: "lark_md", content: lines.join("\n") + resolutionLine(view) } },
                {
                    tag: "action",
                    actions: [
                        buttonState(resolved, {
                            tag: "button",
                            text: { tag: "plain_text", content: "批准开发" },
                            type: "primary",
                            value: { a: "approve", t: view.taskId, h: view.planHash },
                        }),
                        buttonState(resolved, {
                            tag: "button",
                            text: { tag: "plain_text", content: "修改计划" },
                            type: "default",
                            value: { a: "revise", t: view.taskId, h: view.planHash },
                        }),
                        buttonState(resolved, {
                            tag: "button",
                            text: { tag: "plain_text", content: "拒绝" },
                            type: "danger",
                            value: { a: "reject", t: view.taskId, h: view.planHash },
                        }),
                        {
                            tag: "button",
                            text: { tag: "plain_text", content: "回复管理" },
                            type: "default",
                            value: { a: "reply_manage", t: "__manage__" },
                        },
                    ],
                },
            ],
        },
    };
}
export function renderReplyManagementCard(view) {
    const elements = [];
    const section = (title, body) => {
        elements.push({
            tag: "div",
            text: { tag: "lark_md", content: `**${title}**\n${body}` },
        });
    };
    if (view.pending.length === 0 && view.sent.length === 0) {
        section("回复管理", "当前没有待审批草稿，也没有可撤回回复。");
    }
    if (view.pending.length > 0) {
        section("待审批草稿", `共 ${view.pending.length} 条，取消后不会发送。`);
        for (const item of view.pending.slice(0, 5)) {
            const time = new Date(item.createdAt).toLocaleString("zh-CN", { hour12: false });
            elements.push({
                tag: "div",
                text: {
                    tag: "plain_text",
                    content: [
                        `群：${item.chatLabel}`,
                        `发送人：${item.senderLabel}`,
                        `时间：${time}`,
                        `草稿：${item.draft.slice(0, 160)}`,
                        `原消息：${item.excerpt.slice(0, 120)}`,
                        `任务：${item.taskId}`,
                    ].join("\n"),
                },
            });
            elements.push({
                tag: "action",
                actions: [
                    {
                        tag: "button",
                        text: { tag: "plain_text", content: "取消此草稿" },
                        type: "danger",
                        value: { a: "cancel_pending", t: item.taskId, h: item.planHash },
                    },
                    {
                        tag: "button",
                        text: { tag: "plain_text", content: "返回审批" },
                        type: "default",
                        value: { a: "restore_approval", t: item.taskId, h: item.planHash },
                    },
                ],
            });
        }
        if (view.pending.length > 5) {
            elements.push({
                tag: "div",
                text: {
                    tag: "plain_text",
                    content: `待审批仅显示最近 5 条，共 ${view.pending.length} 条。`,
                },
            });
        }
    }
    if (view.sent.length > 0) {
        section("最近已发送", "最近 5 条可撤回回复；受企业撤回时限限制（默认 24 小时）。");
        for (const item of view.sent.slice(0, 5)) {
            const time = new Date(item.sentAt).toLocaleString("zh-CN", { hour12: false });
            elements.push({
                tag: "div",
                text: {
                    tag: "plain_text",
                    content: [
                        `群：${item.chatLabel}`,
                        `发送人：${item.senderLabel}`,
                        `时间：${time}`,
                        `回复：${item.text.slice(0, 160)}`,
                        `原消息：${item.sourceText.slice(0, 120)}`,
                    ].join("\n"),
                },
            });
            elements.push({
                tag: "action",
                actions: [
                    {
                        tag: "button",
                        text: { tag: "plain_text", content: "撤回此回复" },
                        type: "danger",
                        value: { a: "recall_reply", t: "__manage__", r: item.id },
                    },
                ],
            });
        }
        if (view.sent.length > 5) {
            elements.push({
                tag: "div",
                text: {
                    tag: "plain_text",
                    content: `已发送仅显示最近 5 条，共 ${view.sent.length} 条。`,
                },
            });
        }
    }
    return {
        kind: "card",
        card: {
            config: { wide_screen_mode: true },
            header: {
                template: "orange",
                title: { tag: "plain_text", content: "回复管理" },
            },
            elements,
        },
    };
}
export function renderCancelConfirmCard(input) {
    return {
        kind: "card",
        card: {
            config: { wide_screen_mode: true },
            header: {
                template: "red",
                title: { tag: "plain_text", content: "确认取消草稿" },
            },
            elements: [
                {
                    tag: "div",
                    text: {
                        tag: "plain_text",
                        content: [
                            "取消后这条草稿不会发送。",
                            ...(input.draft ? [`草稿：${input.draft.slice(0, 160)}`] : []),
                            `任务：${input.taskId}`,
                        ].join("\n"),
                    },
                },
                {
                    tag: "action",
                    actions: [
                        {
                            tag: "button",
                            text: { tag: "plain_text", content: "确认取消" },
                            type: "danger",
                            value: { a: "cancel_pending_confirm", t: input.taskId, h: input.planHash },
                        },
                        {
                            tag: "button",
                            text: { tag: "plain_text", content: "返回审批" },
                            type: "default",
                            value: { a: "restore_approval", t: input.taskId, h: input.planHash },
                        },
                    ],
                },
            ],
        },
    };
}
export function parseCardAction(raw) {
    const messageId = raw?.context?.open_message_id ?? raw?.open_message_id;
    const chatId = raw?.context?.open_chat_id ?? raw?.open_chat_id;
    const operatorOpenId = raw?.operator?.open_id;
    const value = raw?.action?.value;
    if (!operatorOpenId || !value || typeof value !== "object")
        return undefined;
    const taskId = typeof value.t === "string" ? value.t : "";
    const action = typeof value.a === "string" ? value.a : "";
    if (!taskId || !action)
        return undefined;
    return {
        platform: "feishu",
        actionId: typeof raw?.event_id === "string" ? raw.event_id : `${taskId}:${action}`,
        taskId,
        ...(typeof value.h === "string" ? { planHash: value.h } : {}),
        ...(typeof value.r === "string" ? { replyId: value.r } : {}),
        action,
        ...(chatId ? { chatId } : {}),
        ...(messageId ? { messageId } : {}),
        actor: { platform: "feishu", id: operatorOpenId },
        raw,
    };
}
function createLarkClient(config, appSecret) {
    return new Lark.Client({
        appId: config.appId,
        appSecret,
        domain: config.domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu,
        logger: { error: () => { }, warn: () => { }, info: () => { }, debug: () => { }, trace: () => { } },
    });
}
//# sourceMappingURL=adapter.js.map