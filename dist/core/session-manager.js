export class SessionManager {
    options;
    coordinatorLocks = new Map();
    workerLocks = new Map();
    constructor(options) {
        this.options = options;
    }
    async coordinatorSession(platform, chatId, directory, title) {
        const key = `coordinator:${platform}:${chatId}`;
        const existing = this.options.sessions.get(key);
        if (existing) {
            const probe = this.options.bridge.getSession;
            if (!probe)
                return existing.sessionId;
            const alive = await probe.call(this.options.bridge, existing.sessionId, existing.directory);
            if (!alive || alive.timeArchived) {
                this.options.sessions.delete(key);
            }
            else {
                return existing.sessionId;
            }
        }
        const inflight = this.coordinatorLocks.get(key);
        if (inflight)
            return inflight;
        const promise = (async () => {
            const sessionId = await this.options.bridge.createSession({
                directory,
                title,
                ...(this.options.config.opencode.agent
                    ? { agent: this.options.config.opencode.agent }
                    : {}),
            });
            this.options.sessions.set(key, sessionId, directory, {
                kind: "coordinator",
                createdAt: Date.now(),
            });
            await this.options.sessions.flush();
            this.options.logger.info("coordinator session ready", { sessionId, chatId, directory });
            return sessionId;
        })();
        this.coordinatorLocks.set(key, promise);
        try {
            return await promise;
        }
        finally {
            this.coordinatorLocks.delete(key);
        }
    }
    async createGroupSession(platform, chatId, directory) {
        const key = `group:${platform}:${chatId}`;
        const existing = this.options.sessions.get(key);
        if (existing) {
            const probe = this.options.bridge.getSession;
            if (probe) {
                const alive = await probe.call(this.options.bridge, existing.sessionId, existing.directory);
                if (alive && !alive.timeArchived)
                    return existing.sessionId;
            }
            else {
                return existing.sessionId;
            }
            this.options.sessions.delete(key);
        }
        const sessionId = await this.options.bridge.createSession({
            directory,
            title: `${this.options.config.opencode.sessionTitlePrefix}:group:${chatId}`,
            permission: this.options.readOnlyPermission,
            ...(this.options.config.opencode.agent
                ? { agent: this.options.config.opencode.agent }
                : {}),
        });
        this.options.sessions.set(key, sessionId, directory, {
            kind: "group",
            createdAt: Date.now(),
        });
        await this.options.sessions.flush();
        return sessionId;
    }
    async createWorkerSession(input) {
        const key = `worker:${input.role}:${input.platform}:${input.chatId}`;
        const existing = this.options.sessions.get(key);
        if (existing && existing.directory === input.directory) {
            const probe = this.options.bridge.getSession;
            if (!probe)
                return existing.sessionId;
            const alive = await probe.call(this.options.bridge, existing.sessionId, existing.directory);
            if (alive && !alive.timeArchived)
                return existing.sessionId;
        }
        if (existing)
            this.options.sessions.delete(key);
        const coordinator = await this.coordinatorSession(input.platform, input.chatId, input.directory, `${this.options.config.opencode.sessionTitlePrefix}:chat:${input.chatId}`);
        const roleAgent = input.role === "analysis"
            ? this.options.config.subagents.analyst
            : input.role === "review"
                ? this.options.config.subagents.reviewer
                : input.agent;
        const sessionId = await this.options.bridge.createSession({
            directory: input.directory,
            title: input.title,
            parentID: coordinator,
            ...(roleAgent ? { agent: roleAgent } : {}),
            ...(input.permission ? { permission: input.permission } : {}),
            ...(input.model ? { model: input.model } : {}),
        });
        this.options.sessions.set(key, sessionId, input.directory, {
            kind: "worker",
            createdAt: Date.now(),
        });
        await this.options.sessions.flush();
        return sessionId;
    }
    async runWorker(input, promptText, signal) {
        if (!this.options.config.subagents.enabled) {
            const { sessionId, release } = await this.options.createChildSession({
                ...input,
                ...(signal ? { signal } : {}),
            });
            try {
                return await this.options.bridge.prompt(sessionId, {
                    directory: input.directory,
                    title: input.title,
                    text: promptText,
                    ...(signal ? { signal } : {}),
                });
            }
            finally {
                release();
                await this.options.finishSession(sessionId, input.title, input.directory, "worker_fallback");
            }
        }
        const key = `worker:${input.role}:${input.platform}:${input.chatId}`;
        const run = async () => {
            const sessionId = await this.createWorkerSession(input);
            return this.options.bridge.prompt(sessionId, {
                directory: input.directory,
                title: input.title,
                text: promptText,
                ...(signal ? { signal } : {}),
            });
        };
        const previous = this.workerLocks.get(key) ?? Promise.resolve();
        const current = previous.then(run, run);
        const tail = current.then(() => undefined, () => undefined);
        this.workerLocks.set(key, tail);
        try {
            return await current;
        }
        finally {
            if (this.workerLocks.get(key) === tail)
                this.workerLocks.delete(key);
        }
    }
}
//# sourceMappingURL=session-manager.js.map