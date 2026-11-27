export function parsePermissionReply(text) {
    const value = text
        .replace(/[。！？!,.，\s]/g, "")
        .trim()
        .toLowerCase();
    if (/^(拒绝|不同意|不允许|不行|不好|反对|取消|不要|别|no|n|stop)$/.test(value)) {
        return "deny";
    }
    if (/^(允许|批准|同意|可以|确认|通过|行|好|好的|ok|okay|yes|y|嗯|中|继续|干吧|没问题)$/.test(value)) {
        return "allow";
    }
    return undefined;
}
export class PermissionBridge {
    options;
    pending = new Map();
    abort;
    started = false;
    constructor(options) {
        this.options = options;
    }
    async start() {
        if (this.started)
            return;
        const client = this.options.bridge.getClient();
        if (!client.event?.subscribe) {
            this.options.logger.warn("opencode event subscribe unavailable; permission bridge disabled");
            return;
        }
        this.started = true;
        this.abort = new AbortController();
        void this.syncPending();
        void this.reconnect();
    }
    async syncPending() {
        try {
            const client = this.options.bridge.getClient();
            const result = await client.permission?.list();
            const items = Array.isArray(result?.data) ? result.data : Array.isArray(result) ? result : [];
            for (const item of items) {
                await this.handleRequest({
                    type: "permission.asked",
                    data: {
                        id: item.id ?? item.requestID,
                        permission: item.permission,
                        patterns: item.patterns,
                        sessionID: item.sessionID,
                        metadata: item.metadata,
                    },
                });
            }
        }
        catch (error) {
            this.options.logger.debug("permission pending sync failed", {
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    async reconnect() {
        while (!this.abort?.signal.aborted) {
            try {
                await this.consume();
            }
            catch (error) {
                this.options.logger.warn("permission event stream failed; retrying", {
                    error: error instanceof Error ? error.message : String(error),
                });
            }
            if (this.abort?.signal.aborted)
                break;
            await new Promise((resolve) => {
                const timer = setTimeout(resolve, 3000);
                timer.unref?.();
            });
        }
    }
    async consume() {
        const client = this.options.bridge.getClient();
        if (!client.event?.subscribe) {
            this.options.logger.warn("opencode event subscribe unavailable; permission bridge disabled");
            return;
        }
        const events = await client.event.subscribe();
        for await (const event of events.stream) {
            if (this.abort?.signal.aborted)
                break;
            if (await this.handleCompaction(event))
                continue;
            await this.handleRequest(event);
        }
    }
    pendingCount() {
        return this.pending.size;
    }
    async handleCompaction(event) {
        if (event?.type !== "session.compacted" && event?.type !== "session.next.compaction.ended") {
            return false;
        }
        const data = event.data ?? event.properties ?? {};
        const sessionId = String(data.sessionID ?? data.sessionId ?? "");
        if (sessionId)
            await this.options.onSessionCompacted?.(sessionId);
        return true;
    }
    async handleRequest(event) {
        if (event?.type !== "permission.asked" && event?.type !== "permission.v2.asked")
            return;
        const data = event.data ?? {};
        const request = {
            requestID: String(data.id ?? data.requestID ?? ""),
            permission: String(data.permission ?? "unknown"),
            patterns: Array.isArray(data.patterns) ? data.patterns.map(String) : [],
            sessionID: String(data.sessionID ?? ""),
            ...(data.metadata && typeof data.metadata === "object"
                ? { metadata: data.metadata }
                : {}),
        };
        if (!request.requestID || this.pending.has(request.requestID))
            return;
        this.pending.set(request.requestID, request);
        const view = {
            requestId: request.requestID,
            ...(request.sessionID ? { sessionId: request.sessionID } : {}),
            permission: request.permission,
            patterns: request.patterns,
            ...(request.metadata ? { metadata: request.metadata } : {}),
        };
        const sent = await this.options.sendPermissionCard?.(view);
        if (sent)
            return;
        await this.options.sendToOwner([
            "OpenCode 权限请求",
            `ID：${request.requestID}`,
            `session：${request.sessionID || "unknown"}`,
            `权限：${request.permission}`,
            `目标：${request.patterns.join("、") || "unknown"}`,
            ...(request.metadata ? [`详情：${JSON.stringify(request.metadata).slice(0, 800)}`] : []),
            "可直接回复：允许 / 拒绝",
            `或：/允许 ${request.requestID} / 拒绝 ${request.requestID}`,
        ].join("\n"));
    }
    requestView(requestId) {
        const request = this.pending.get(requestId);
        if (!request)
            return undefined;
        return {
            requestId: request.requestID,
            ...(request.sessionID ? { sessionId: request.sessionID } : {}),
            permission: request.permission,
            patterns: request.patterns,
            ...(request.metadata ? { metadata: request.metadata } : {}),
        };
    }
    async reply(arg, reply) {
        const id = arg.trim() || [...this.pending.keys()][0] || "";
        if (!id)
            return "当前没有待处理权限请求。";
        const request = this.pending.get(id);
        if (!request)
            return `找不到权限请求：${id}`;
        const client = this.options.bridge.getClient();
        if (!client.permission?.reply)
            return "当前 OpenCode 不支持权限回复。";
        const result = await client.permission.reply({ requestID: id, reply });
        if (result?.error)
            return `权限回复失败：${JSON.stringify(result.error).slice(0, 300)}`;
        this.pending.delete(id);
        return reply === "reject" ? `已拒绝权限请求：${id}` : `已允许权限请求：${id}`;
    }
    stop() {
        this.abort?.abort();
        this.abort = undefined;
        this.started = false;
        this.pending.clear();
    }
}
//# sourceMappingURL=permission-bridge.js.map