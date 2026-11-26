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
        this.started = true;
        const client = this.options.bridge.getClient();
        if (!client.event?.subscribe) {
            this.options.logger.warn("opencode event subscribe unavailable; permission bridge disabled");
            return;
        }
        this.abort = new AbortController();
        void this.consume(client.event.subscribe());
    }
    async consume(eventsPromise) {
        try {
            const events = await eventsPromise;
            for await (const event of events.stream) {
                if (this.abort?.signal.aborted)
                    break;
                if (event?.type !== "permission.asked" && event?.type !== "permission.v2.asked")
                    continue;
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
                if (!request.requestID)
                    continue;
                this.pending.set(request.requestID, request);
                await this.options.sendToOwner([
                    "OpenCode 权限请求",
                    `ID：${request.requestID}`,
                    `session：${request.sessionID || "unknown"}`,
                    `权限：${request.permission}`,
                    `目标：${request.patterns.join("、") || "unknown"}`,
                    ...(request.metadata
                        ? [`详情：${JSON.stringify(request.metadata).slice(0, 800)}`]
                        : []),
                    `允许：/允许 ${request.requestID}`,
                    `拒绝：/拒绝 ${request.requestID}`,
                ].join("\n"));
            }
        }
        catch (error) {
            this.options.logger.warn("permission event stream failed", {
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    pendingCount() {
        return this.pending.size;
    }
    onlyPendingId() {
        return this.pending.size === 1 ? [...this.pending.keys()][0] : undefined;
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