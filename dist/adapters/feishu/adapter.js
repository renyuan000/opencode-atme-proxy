import * as Lark from "@larksuiteoapi/node-sdk";
import { createLogger } from "../../core/logger.js";
import { toErrorMessage, truncate } from "../../core/util.js";
function normalizeAppLink(value) {
    const trimmed = value?.trim();
    if (!trimmed)
        return undefined;
    if (/^https?:\/\//i.test(trimmed))
        return trimmed;
    if (trimmed.startsWith("//"))
        return `https:${trimmed}`;
    return `https://${trimmed.replace(/^\/+/, "")}`;
}
function isMessageAppLink(value) {
    return /\/client\/message\/link\/open\?/.test(value) || /[?&](position|thread_position)=/.test(value);
}
function buildMessageLink(chatId, raw) {
    const appLink = normalizeAppLink(raw.message_app_link);
    if (appLink && isMessageAppLink(appLink))
        return appLink;
    const position = raw.message_position == null ? "" : String(raw.message_position).trim();
    if (position) {
        return `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(chatId)}&position=${encodeURIComponent(position)}`;
    }
    return undefined;
}
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
    const messageLink = buildMessageLink(chatId, raw);
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
            ...(raw.sender?.sender_name ? { displayName: raw.sender.sender_name } : {}),
        },
        senderType,
        text,
        mentions,
        ...(raw.parent_id ? { replyToMessageId: raw.parent_id } : {}),
        ...(raw.root_id ?? raw.thread_id ? { threadId: raw.root_id ?? raw.thread_id } : {}),
        ...(messageLink ? { messageLink } : {}),
        createdAt: Number(raw.create_time ?? Date.now()),
        rawType: raw.message_type ?? "unknown",
        ...(attachments.length > 0 ? { attachments } : {}),
    };
}
function mapHistoryItem(item) {
    return mapFeishuMessage({
        message_id: item?.message_id,
        chat_id: item?.chat_id,
        chat_type: item?.chat_type,
        message_type: item?.msg_type ?? item?.message_type,
        content: item?.body?.content ?? item?.content,
        create_time: item?.create_time,
        parent_id: item?.parent_id,
        root_id: item?.root_id,
        thread_id: item?.thread_id,
        message_app_link: item?.message_app_link,
        message_position: item?.message_position,
        sender: item?.sender
            ? {
                sender_id: {
                    open_id: item.sender.sender_id?.open_id ?? item.sender.id,
                },
                sender_type: item.sender.sender_type,
                sender_name: item.sender.sender_name ?? item.sender.name,
            }
            : undefined,
        mentions: Array.isArray(item?.mentions)
            ? item.mentions.map((mention) => ({
                key: mention.key,
                id: { open_id: mention.id },
                name: mention.name,
            }))
            : undefined,
    });
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
        return "[图片]";
    if (type === "file")
        return "[文件]";
    if (type === "audio")
        return "[音频]";
    if (type === "media" || type === "video")
        return "[视频]";
    if (type === "interactive") {
        try {
            const parsed = JSON.parse(raw.content);
            const parts = [];
            collectCardText(parsed, parts);
            return parts.join(" ").trim() || "[interactive]";
        }
        catch {
            return "[interactive]";
        }
    }
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
function collectCardText(value, parts) {
    if (typeof value === "string") {
        if (value.trim())
            parts.push(value.trim());
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value)
            collectCardText(item, parts);
        return;
    }
    if (!value || typeof value !== "object")
        return;
    for (const [key, item] of Object.entries(value)) {
        if (key === "text" || key === "content" || key === "title") {
            collectCardText(item, parts);
        }
        else if (typeof item === "object") {
            collectCardText(item, parts);
        }
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
                parts.push(width && height ? `[图片 ${width}x${height}]` : "[图片]");
                continue;
            }
            if (record.tag === "media") {
                parts.push("[视频]");
                continue;
            }
            if (record.tag === "file") {
                const name = typeof record.file_name === "string" ? record.file_name : "";
                parts.push(name ? `[文件 ${name}]` : "[文件]");
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
    botName;
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
    getBotName() {
        return this.botName;
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
    async fetchUserName(openId) {
        const response = await this.client.request({
            method: "GET",
            url: `/open-apis/contact/v3/users/${encodeURIComponent(openId)}`,
            params: { user_id_type: "open_id" },
        });
        if (response?.code !== 0) {
            this.logger.warn("feishu user name lookup failed", {
                openId,
                code: response?.code,
                msg: response?.msg,
            });
            return undefined;
        }
        const name = response?.data?.user?.name;
        if (typeof name !== "string" || !name) {
            this.logger.warn("feishu user name lookup returned no name", { openId });
            return undefined;
        }
        return name;
    }
    async forwardMessage(messageId, target) {
        const receiveIdType = target.kind === "chat" ? "chat_id" : "open_id";
        const receiveId = target.kind === "chat" ? target.chatId : target.userId;
        const response = await this.client.request({
            method: "POST",
            url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/forward`,
            params: { receive_id_type: receiveIdType },
            data: { receive_id: receiveId },
        });
        return this.requireMessageId(response, "forward");
    }
    async fetchMessage(messageId) {
        const response = await this.client.request({
            method: "GET",
            url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
            params: { with_sender_name: true },
        });
        if (response?.code !== 0) {
            throw new Error(`Feishu get message failed: ${response?.msg ?? "unknown"}`);
        }
        const item = response?.data?.items?.[0];
        if (!item)
            return undefined;
        return mapHistoryItem(item);
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
                const mapped = mapHistoryItem(item);
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
    renderNotification(view) {
        return renderNotificationCard(view);
    }
    renderApproval(view) {
        return renderApprovalCard(view);
    }
    renderPermissionRequest(view) {
        return renderPermissionCard(view);
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
    async fetchDocumentText(url) {
        const match = url.match(/(?:\/wiki\/|\/docx\/|\/docs\/|\/sheets\/)([A-Za-z0-9_-]+)/);
        if (!match?.[1])
            return undefined;
        const kind = url.includes("/wiki/")
            ? "wiki"
            : url.includes("/docx/")
                ? "docx"
                : url.includes("/sheets/")
                    ? "sheets"
                    : "docs";
        const token = match[1];
        try {
            if (kind === "wiki") {
                const node = await this.client.request({
                    method: "GET",
                    url: "/open-apis/wiki/v2/spaces/get_node",
                    params: { token },
                });
                if (node?.code !== 0 || !node?.data?.node) {
                    this.logger.warn("Feishu wiki node read failed", { url, code: node?.code, msg: node?.msg });
                    return undefined;
                }
                const objType = node.data.node.obj_type;
                const objToken = node.data.node.obj_token;
                if (!objToken)
                    return undefined;
                if (objType === "docx") {
                    const result = await this.readDocx(objToken);
                    return result ? { title: node.data.node.title, ...result, url } : undefined;
                }
                if (objType === "doc") {
                    const result = await this.readLegacyDoc(objToken);
                    return result ? { title: node.data.node.title, ...result, url } : undefined;
                }
                if (objType === "sheet") {
                    const result = await this.readSpreadsheet(objToken, url);
                    return result ? { title: node.data.node.title, ...result, url } : undefined;
                }
                this.logger.info("unsupported Feishu wiki object", { url, objType });
                return undefined;
            }
            if (kind === "sheets") {
                return await this.readSpreadsheet(token, url);
            }
            if (kind === "docx") {
                const result = await this.readDocx(token);
                return result ? { ...result, url } : undefined;
            }
            const result = await this.readLegacyDoc(token);
            return result ? { ...result, url } : undefined;
        }
        catch (error) {
            this.logger.warn("Feishu document read failed", { url, error: toErrorMessage(error) });
            return undefined;
        }
    }
    async readSpreadsheet(token, url) {
        try {
            const meta = await this.client.request({
                method: "GET",
                url: `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(token)}/metainfo`,
            });
            if (meta?.code !== 0) {
                this.logger.warn("Feishu spreadsheet metainfo failed", { url, code: meta?.code, msg: meta?.msg });
                return undefined;
            }
            const sheets = meta?.data?.sheets ?? meta?.data?.spreadsheet?.sheets ?? [];
            if (!Array.isArray(sheets) || sheets.length === 0)
                return undefined;
            const lines = [];
            for (const sheet of sheets.slice(0, 5)) {
                const sheetId = sheet.sheet_id ?? sheet.sheetId ?? sheet.id;
                if (!sheetId)
                    continue;
                const range = `${sheetId}!A1:Z300`;
                const response = await this.client.request({
                    method: "GET",
                    url: `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(token)}/values/${encodeURIComponent(range)}`,
                    params: { valueRenderOption: "ToString", dateTimeRenderOption: "FormattedString" },
                });
                if (response?.code !== 0)
                    continue;
                const values = response?.data?.valueRange?.values ?? response?.data?.values ?? [];
                if (!Array.isArray(values) || values.length === 0)
                    continue;
                lines.push(`### Sheet: ${sheet.title ?? sheetId}`);
                for (const row of values) {
                    if (!Array.isArray(row))
                        continue;
                    const cells = row.map((cell) => (cell === null || cell === undefined ? "" : String(cell)));
                    if (cells.some((cell) => cell !== ""))
                        lines.push(cells.join("\t"));
                }
            }
            if (lines.length === 0)
                return undefined;
            return {
                ...(typeof sheets[0]?.title === "string" ? { title: sheets[0].title } : {}),
                text: lines.join("\n"),
                url,
            };
        }
        catch (error) {
            this.logger.warn("Feishu spreadsheet read failed", { url, error: toErrorMessage(error) });
            return undefined;
        }
    }
    async readDocx(token) {
        const response = await this.client.request({
            method: "GET",
            url: `/open-apis/docx/v1/documents/${encodeURIComponent(token)}/raw_content`,
        });
        if (response?.code !== 0) {
            this.logger.warn("Feishu docx raw_content failed", { token, code: response?.code, msg: response?.msg });
            return undefined;
        }
        const text = response?.data?.content ?? response?.data?.raw_content ?? response?.data?.document?.content;
        return typeof text === "string" && text.trim() ? { text: text.trim() } : undefined;
    }
    async readLegacyDoc(token) {
        const response = await this.client.request({
            method: "GET",
            url: `/open-apis/doc/v2/${encodeURIComponent(token)}/raw_content`,
        });
        if (response?.code !== 0) {
            this.logger.warn("Feishu legacy doc raw_content failed", { token, code: response?.code, msg: response?.msg });
            return undefined;
        }
        const text = response?.data?.content ?? response?.data?.raw_content;
        return typeof text === "string" && text.trim() ? { text: text.trim() } : undefined;
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
        }
        try {
            const response = await this.client.request({ method: "GET", url: "/open-apis/bot/v3/info" });
            const bot = response?.bot ?? response?.data?.bot;
            const openId = bot?.open_id;
            if (typeof openId === "string") {
                this.botOpenId = openId;
            }
            else if (!this.botOpenId) {
                this.logger.warn("bot open_id not found in /bot/v3/info response");
            }
            const name = bot?.app_name ?? bot?.name;
            if (typeof name === "string" && name)
                this.botName = name;
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
function renderNotificationHeaderMeta(meta) {
    const left = meta?.left?.trim();
    const right = meta?.right?.trim();
    if (!left && !right)
        return undefined;
    const columns = [];
    if (right) {
        columns.push(left
            ? {
                tag: "column",
                width: "weighted",
                weight: 1,
                vertical_align: "center",
                elements: [{ tag: "div", text: { tag: "lark_md", content: left } }],
            }
            : {
                tag: "column",
                width: "weighted",
                weight: 1,
                vertical_align: "center",
                elements: [{ tag: "div", text: { tag: "lark_md", content: " " } }],
            });
        columns.push({
            tag: "column",
            width: "auto",
            vertical_align: "center",
            elements: [{ tag: "div", text: { tag: "lark_md", content: right } }],
        });
    }
    else if (left) {
        columns.push({
            tag: "column",
            width: "auto",
            vertical_align: "center",
            elements: [{ tag: "div", text: { tag: "lark_md", content: left } }],
        });
    }
    return {
        tag: "column_set",
        flex_mode: columns.length > 1 ? "stretch" : "none",
        horizontal_spacing: "default",
        columns,
    };
}
export function renderNotificationCard(view) {
    const elements = [];
    const headerMeta = renderNotificationHeaderMeta(view.headerMeta);
    if (headerMeta)
        elements.push(headerMeta);
    if (view.subtitle) {
        elements.push({ tag: "div", text: { tag: "lark_md", content: view.subtitle } });
    }
    if (headerMeta || view.subtitle)
        elements.push({ tag: "hr" });
    view.sections.forEach((section, index) => {
        if (index > 0)
            elements.push({ tag: "hr" });
        const lines = [`**${section.title}**${section.meta ? ` · ${section.meta}` : ""}`];
        if (section.quote)
            lines.push(`> ${section.quote}`);
        if (section.detail)
            lines.push(`<font color='grey'>${section.detail}</font>`);
        if (section.link)
            lines.push(`[${section.link.label}](${section.link.url})`);
        elements.push({ tag: "div", text: { tag: "lark_md", content: lines.join("\n") } });
    });
    if (view.footer) {
        elements.push({ tag: "div", text: { tag: "lark_md", content: view.footer } });
    }
    if (view.link) {
        elements.push({
            tag: "div",
            text: { tag: "lark_md", content: `[${view.link.label}](${view.link.url})` },
        });
    }
    return {
        kind: "card",
        card: {
            config: { wide_screen_mode: true },
            header: {
                template: "blue",
                title: { tag: "plain_text", content: view.title },
            },
            elements,
        },
    };
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
                        content: resolved
                            ? "已处理：代答审批"
                            : `需要你确认：是否代答${view.chatLabel ? ` · ${view.chatLabel}` : ""}`,
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
        ...(view.chatLabel ? [`**群**：${view.chatLabel}`] : []),
        ...(view.sourceLink
            ? [`**原消息**：[${view.sourceLink.label}](${view.sourceLink.url})`]
            : []),
        `**目标**：${view.title}`,
        ...(view.scope?.length ? [`**范围**：${truncate(view.scope.join("；"), 400)}`] : []),
        ...(view.files?.length ? [`**计划文件**：${truncate(view.files.join("；"), 400)}`] : []),
        ...(view.plan?.length ? [`**执行计划**：${truncate(view.plan.join("；"), 800)}`] : []),
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
    const displayLabel = (value, fallback) => {
        if (!value)
            return fallback;
        if (/^ou_/.test(value))
            return "未知成员";
        if (/^oc_/.test(value))
            return "未知群";
        return value;
    };
    const elements = [];
    const groupHeader = (label) => {
        elements.push({
            tag: "div",
            text: { tag: "lark_md", content: `<font color='blue'>**${label}**</font>` },
        });
    };
    const itemText = (lines) => {
        elements.push({
            tag: "div",
            text: { tag: "plain_text", content: lines.join("\n") },
        });
    };
    const itemActions = (actions) => {
        elements.push({ tag: "action", actions });
    };
    const groupLabels = new Map();
    const groupKey = (label) => label || "__unknown__";
    const groupLabel = (label) => {
        const key = groupKey(label);
        const existing = groupLabels.get(key);
        if (existing)
            return existing;
        const next = displayLabel(label, "未知群");
        groupLabels.set(key, next);
        return next;
    };
    const pendingByGroup = new Map();
    for (const item of view.pending) {
        const key = groupKey(item.chatLabel);
        groupLabel(item.chatLabel);
        const group = pendingByGroup.get(key) ?? [];
        group.push(item);
        pendingByGroup.set(key, group);
    }
    const sentByGroup = new Map();
    for (const item of view.sent) {
        const key = groupKey(item.chatLabel);
        groupLabel(item.chatLabel);
        const group = sentByGroup.get(key) ?? [];
        group.push(item);
        sentByGroup.set(key, group);
    }
    const groupKeys = [...new Set([...pendingByGroup.keys(), ...sentByGroup.keys()])];
    if (view.pending.length === 0 && view.sent.length === 0) {
        itemText(["当前没有待审批草稿，也没有可撤回回复。"]);
    }
    if (view.pending.length > 0) {
        elements.push({ tag: "div", text: { tag: "lark_md", content: "**待审批草稿**" } });
        for (const [key, items] of pendingByGroup) {
            groupHeader(groupLabels.get(key) ?? "未知群");
            for (const item of items.slice(0, 5)) {
                const time = new Date(item.createdAt).toLocaleString("zh-CN", { hour12: false });
                itemText([
                    `发送人：${displayLabel(item.senderLabel, "未知成员")}`,
                    `时间：${time}`,
                    `草稿：${item.draft.slice(0, 160)}`,
                    `原消息：${item.excerpt.slice(0, 120)}`,
                ]);
                itemActions([
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
                ]);
            }
        }
    }
    if (view.sent.length > 0) {
        elements.push({
            tag: "div",
            text: { tag: "lark_md", content: "**最近已发送（仅可撤回）**" },
        });
        for (const [key, items] of sentByGroup) {
            groupHeader(groupLabels.get(key) ?? "未知群");
            for (const item of items.slice(0, 8)) {
                const time = new Date(item.sentAt).toLocaleString("zh-CN", { hour12: false });
                itemText([
                    `发送人：${displayLabel(item.senderLabel, "未知成员")}`,
                    `时间：${time}`,
                    `回复：${item.text.slice(0, 160)}`,
                    `原消息：${item.sourceText.slice(0, 120)}`,
                ]);
                itemActions([
                    {
                        tag: "button",
                        text: { tag: "plain_text", content: "撤回此回复" },
                        type: "danger",
                        value: { a: "recall_reply", t: "__manage__", r: item.id },
                    },
                ]);
            }
        }
    }
    return {
        kind: "card",
        card: {
            config: { wide_screen_mode: true },
            header: {
                template: "orange",
                title: {
                    tag: "plain_text",
                    content: groupKeys.length === 0
                        ? "回复管理"
                        : groupKeys.length === 1
                            ? `回复管理 · ${groupLabels.get(groupKeys[0]) ?? "未知群"}`
                            : `回复管理 · ${groupKeys.length} 个群`,
                },
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
export function renderPermissionCard(view) {
    const details = view.metadata ? JSON.stringify(view.metadata).slice(0, 1200) : "无";
    const resolved = Boolean(view.resolution);
    return {
        kind: "card",
        card: {
            config: { wide_screen_mode: true },
            header: {
                template: view.resolution === "allow" ? "green" : view.resolution === "deny" ? "red" : "orange",
                title: {
                    tag: "plain_text",
                    content: resolved
                        ? view.resolution === "allow"
                            ? "已允许：OpenCode 权限请求"
                            : "已拒绝：OpenCode 权限请求"
                        : "OpenCode 权限请求",
                },
            },
            elements: [
                {
                    tag: "div",
                    text: {
                        tag: "lark_md",
                        content: [
                            `**ID**：${view.requestId}`,
                            `**权限**：${view.permission}`,
                            `**目标**：${view.patterns.join("、") || "unknown"}`,
                            `**详情**：${details}`,
                            resolved ? "已处理" : "可直接回复：允许 / 拒绝（或点击按钮）",
                        ].join("\n"),
                    },
                },
                ...(resolved
                    ? []
                    : [{
                            tag: "action",
                            actions: [
                                {
                                    tag: "button",
                                    text: { tag: "plain_text", content: "允许" },
                                    type: "primary",
                                    value: { a: "permission_allow", t: view.requestId },
                                },
                                {
                                    tag: "button",
                                    text: { tag: "plain_text", content: "拒绝" },
                                    type: "danger",
                                    value: { a: "permission_deny", t: view.requestId },
                                },
                            ],
                        }]),
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