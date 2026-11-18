import { join } from "node:path";
import { createLogger } from "./logger.js";
import { OpenAiCompatibleClient, RelevanceService, buildBotIntentPrompt, makeDedupKey, parseBotIntent, parseJsonLoose, } from "./relevance.js";
import { detectReplyDepth, detectReplyStyle, enforceReplyLength, } from "./reply-style.js";
import { DedupStore } from "./dedup.js";
import { CursorStore } from "./cursor.js";
import { SessionStore } from "./session-store.js";
import { TaskStore } from "./task-store.js";
import { ApprovalStore } from "./approval-store.js";
import { AuditLog } from "./audit.js";
import { ConcurrentDispatcher } from "./dispatcher.js";
import { PollingService } from "./poller.js";
import { PendingStore } from "./pending-store.js";
import { TokenBucket } from "./rate-limit.js";
import { GitExecutor } from "./executor.js";
import { ProjectResolver, candidateLogFields } from "./project-resolver.js";
import { OpenCodeLlmClient } from "./opencode-llm.js";
import { selectBurstExtensions, mergeBurst } from "./burst.js";
import { ProjectStore } from "./project-store.js";
import { ChatContextStore } from "./chat-context.js";
import { EvidenceStore } from "./evidence-store.js";
import { GroupContextStore } from "./group-context.js";
import { MemoryStore } from "./memory-store.js";
import { SenderLimiter } from "./sender-limiter.js";
import { SessionManager } from "./session-manager.js";
import { ContextService } from "./context-service.js";
import { ApprovalService } from "./approval-service.js";
import { ExecutionService } from "./execution-service.js";
import { OwnerCommandService } from "./owner-command-service.js";
import { ReplyService } from "./reply-service.js";
import { parseAnalysis } from "./analysis.js";
import { buildAnalysisPrompt } from "./prompts.js";
import { parseOwnerCommand } from "./owner-command.js";
import { deterministicVerification, mergeVerification, parseVerification, } from "./analysis-verify.js";
import { OwnerStore } from "./owner-store.js";
import { readJsonFile, formatLocalTime, sha256, stableUuid, toErrorMessage, redactPreview, isLowValueMessage, truncate, truncateMiddle, writeJsonAtomic, } from "./util.js";
const ASSISTANT_LABEL = "（助手代答）";
const READ_ONLY_PERMISSION = [
    { permission: "edit", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "*", action: "deny" },
    { permission: "webfetch", pattern: "*", action: "deny" },
    { permission: "websearch", pattern: "*", action: "deny" },
    { permission: "external_directory", pattern: "*", action: "deny" },
];
const EXECUTION_PERMISSION = [
    { permission: "webfetch", pattern: "*", action: "deny" },
    { permission: "websearch", pattern: "*", action: "deny" },
    { permission: "external_directory", pattern: "*", action: "deny" },
];
export class ProxyRuntime {
    options;
    logger;
    config;
    stateDir;
    dedup;
    outbound;
    cursors;
    sessions;
    sessionManager;
    chatNames = new Map();
    recentMessages = new Map();
    tasks;
    approvals;
    audit;
    dispatcher;
    sendLimiter;
    relevance;
    llm;
    replyOptions;
    activeMessageIds = new Set();
    pending;
    poller;
    executor;
    started = false;
    groupIds;
    pollingEnabled;
    filterEnabled;
    projectStore;
    chatContext;
    evidence;
    groupContext;
    contextService;
    approvalService;
    executionService;
    ownerCommandService;
    replyService;
    groupLocks = new Map();
    memory;
    owners;
    resolvedOwner;
    claimAttempts = new Map();
    senderLimiter;
    projectResolver;
    background = new Set();
    projectCache = new Map();
    constructor(options) {
        this.options = options;
        this.logger = options.logger ?? createLogger({ scope: "runtime" });
        this.config = options.loaded.config;
        this.stateDir = requireStateDir(this.config);
        this.dedup = new DedupStore({
            file: join(this.stateDir, "dedup.json"),
            ttlMs: 7 * 24 * 3600 * 1000,
            maxEntries: 100_000,
            logger: this.logger.child("dedup"),
        });
        this.outbound = new DedupStore({
            file: join(this.stateDir, "outbound.json"),
            ttlMs: 7 * 24 * 3600 * 1000,
            maxEntries: 50_000,
            logger: this.logger.child("outbound"),
        });
        this.cursors = new CursorStore({
            file: join(this.stateDir, "cursors.json"),
            logger: this.logger.child("cursor"),
        });
        this.sessions = new SessionStore(join(this.stateDir, "sessions.json"), this.logger.child("sessions"));
        this.sessionManager = new SessionManager({
            bridge: this.options.bridge,
            sessions: this.sessions,
            config: this.config,
            logger: this.logger.child("sessions"),
            readOnlyPermission: READ_ONLY_PERMISSION,
        });
        this.tasks = new TaskStore(this.stateDir, this.logger.child("tasks"));
        this.approvals = new ApprovalStore(this.stateDir);
        this.audit = new AuditLog(AuditLog.defaultPath(this.stateDir));
        this.pending = new PendingStore(join(this.stateDir, "pending.json"), this.logger.child("pending"));
        this.approvalService = new ApprovalService({
            config: this.config,
            pending: this.pending,
            tasks: this.tasks,
            approvals: this.approvals,
            audit: this.audit,
            platform: this.options.platform,
            logger: this.logger.child("approval"),
            ownerOpenId: () => this.ownerOpenId(),
            sendToApprover: (text) => this.sendToApprover(text),
            approveReply: (action, pending) => this.approveReply(action, pending),
            startExecution: (task, planHash) => {
                this.track(this.executionService.executeTask(task, planHash)).catch((error) => {
                    this.logger.error("execution failed", {
                        taskId: task.id,
                        error: toErrorMessage(error),
                    });
                });
            },
        });
        this.projectStore = new ProjectStore(join(this.stateDir, "projects.json"), this.logger.child("projects"));
        this.senderLimiter = new SenderLimiter({
            maxPerMinute: this.config.botReply.perSenderPerMinute,
            maxConcurrent: this.config.botReply.perSenderConcurrent,
            cooldownMs: this.config.botReply.cooldownSeconds * 1000,
        });
        this.owners = new OwnerStore(join(this.stateDir, "owner.json"), this.logger.child("owner"));
        this.initOwner();
        this.chatContext = new ChatContextStore({
            file: join(this.stateDir, "chat-context.json"),
            maxMessagesPerChat: this.config.context.maxMessagesPerChat,
            maxCharsPerMessage: this.config.context.maxCharsPerMessage,
            maxChats: this.config.context.maxChats,
            ttlMs: this.config.context.ttlDays * 86_400_000,
            logger: this.logger.child("context"),
        });
        this.memory = new MemoryStore({
            file: join(this.stateDir, "memory.json"),
            shardDir: join(this.stateDir, "memory"),
            maxEntries: this.config.memory.maxEntries,
            ttlMs: this.config.memory.ttlDays * 86_400_000,
            pinnedKinds: this.config.memory.pinnedKinds,
            logger: this.logger.child("memory"),
        });
        this.evidence = new EvidenceStore({
            dir: join(this.stateDir, "replies"),
            enabled: this.config.evidence?.enabled ?? true,
            retentionDays: this.config.evidence?.retentionDays ?? 720,
            maxChars: this.config.evidence?.maxChars ?? 4000,
            logger: this.logger.child("evidence"),
        });
        this.groupContext = new GroupContextStore(join(this.stateDir, "group-context.json"), this.logger.child("group-context"));
        this.contextService = new ContextService({
            config: this.config,
            chatContext: this.chatContext,
            memory: this.memory,
            tasks: this.tasks,
            groupContext: this.groupContext,
            evidence: this.evidence,
        });
        this.dispatcher = new ConcurrentDispatcher({
            concurrency: this.config.concurrency.global,
            perKeyConcurrency: this.config.concurrency.perChat,
            maxQueue: this.config.concurrency.maxQueue,
            defaultTimeoutMs: this.config.concurrency.mentionTimeoutMs,
            defaultRetries: this.config.concurrency.maxRetries,
            retryDelayMs: this.config.concurrency.retryDelayMs,
            logger: this.logger.child("dispatch"),
        });
        this.sendLimiter = new TokenBucket(this.config.platforms.feishu.rateLimit.sendPerSecond, this.config.platforms.feishu.rateLimit.burst);
        this.groupIds = new Set(this.config.platforms.feishu.groups
            .filter((group) => group.enabled)
            .map((group) => group.chatId));
        const filterNeedsExternal = this.config.filter.mode === "external";
        this.filterEnabled =
            this.config.filter.enabled &&
                (!filterNeedsExternal || this.config.policy.allowExternalModel);
        this.pollingEnabled =
            this.config.polling.enabled &&
                options.platform.capabilities().groupHistory &&
                this.filterEnabled;
        if (filterNeedsExternal && this.config.filter.enabled && !this.config.policy.allowExternalModel) {
            this.logger.warn("external filter model disabled by policy; relevance filter is off");
        }
        this.replyOptions = {
            defaultStyle: this.config.reply.defaultStyle,
            maxChars: this.config.reply.maxChars,
            detailMaxChars: this.config.reply.detailMaxChars,
            detailTriggers: this.config.reply.detailTriggers,
        };
        this.ownerCommandService = new OwnerCommandService({
            pending: this.pending,
            tasks: this.tasks,
            audit: this.audit,
            platform: this.options.platform,
            sendLimiter: this.sendLimiter,
            ownerOpenId: () => this.ownerOpenId(),
            replyOptions: this.replyOptions,
            analysisTimeoutMs: this.config.concurrency.analysisTimeoutMs,
            askOpenCode: (message, style, signal) => this.askOpenCode(message, style, signal),
            approveReply: (action, pending) => this.approveReply(action, pending),
            logger: this.logger.child("owner-command"),
        });
        const profile = {
            name: this.config.filter.profile.name,
            role: this.config.filter.profile.role,
            keywords: this.config.filter.profile.keywords,
            projects: this.config.filter.profile.projects,
            tasks: this.config.filter.profile.tasks,
        };
        const keywords = {
            include: [
                ...this.config.filter.profile.keywords,
                ...this.config.filter.profile.projects,
                ...this.config.filter.profile.tasks,
            ],
            exclude: this.config.filter.profile.excludeKeywords,
        };
        const llm = options.llm ?? createFilterClient(options, this.logger);
        this.llm = llm;
        this.replyService = new ReplyService({
            config: this.config,
            contextService: this.contextService,
            chatContext: this.chatContext,
            sessionManager: this.sessionManager,
            tasks: this.tasks,
            pending: this.pending,
            audit: this.audit,
            platform: this.options.platform,
            sendLimiter: this.sendLimiter,
            llm,
            logger: this.logger.child("reply"),
            replyOptions: this.replyOptions,
            readOnlyPermission: READ_ONLY_PERMISSION,
            ownerOpenId: () => this.ownerOpenId(),
            resolveProject: async (chatId) => {
                const project = await this.resolveProject(chatId);
                return { worktree: project.worktree, resolved: project.resolved };
            },
            refreshSummary: (platform, chatId) => this.updateGroupSummary(platform, chatId),
        });
        this.executor = new GitExecutor({
            worktreeRoot: join(this.stateDir, "worktrees"),
            timeoutMs: this.config.policy.executionTimeoutMinutes * 60_000,
            logger: this.logger.child("executor"),
        });
        this.executionService = new ExecutionService({
            config: this.config,
            stateDir: this.stateDir,
            tasks: this.tasks,
            approvals: this.approvals,
            audit: this.audit,
            executor: this.executor,
            bridge: this.options.bridge,
            sessionManager: this.sessionManager,
            logger: this.logger.child("execution"),
            executionPermission: EXECUTION_PERMISSION,
            readOnlyPermission: READ_ONLY_PERMISSION,
            latestAnalysis: (taskId) => this.latestAnalysis(taskId),
            resolveProject: async (chatId) => {
                const project = await this.resolveProject(chatId);
                return { worktree: project.worktree, resolved: project.resolved };
            },
            sendToApprover: (text) => this.sendToApprover(text),
            sendToOwner: (text) => this.sendToOwner(text),
        });
        this.poller = new PollingService({
            enabled: this.config.polling.enabled,
            platform: options.platform,
            cursors: this.cursors,
            groups: this.config.platforms.feishu.groups,
            intervalMs: Math.max(60_000, this.config.polling.intervalSeconds * 1000),
            overlapMs: this.config.polling.overlapSeconds * 1000,
            lookbackMs: this.config.polling.lookbackSeconds * 1000,
            pageSize: this.config.polling.pageSize,
            maxPages: this.config.polling.maxPages,
            maxMessagesPerRun: this.config.budget.maxMessagesPerRun,
            onBatch: async (messages) => {
                await this.handlePolledBatch(messages);
            },
            logger: this.logger.child("poller"),
        });
        this.relevance = new RelevanceService({
            llm,
            profile,
            keywords,
            meOpenId: this.config.platforms.feishu.me.openId,
            botOpenId: this.config.platforms.feishu.botOpenId,
            keywordPrefilter: this.config.filter.keywordPrefilter,
            maxMessagesPerBatch: this.config.filter.maxMessagesPerBatch,
            maxCharsPerMessage: this.config.filter.maxCharsPerMessage,
            minTaskConfidence: this.config.filter.minTaskConfidence,
            minReviewConfidence: this.config.filter.minReviewConfidence,
            logger: this.logger.child("relevance"),
        });
    }
    initOwner() {
        const feishu = this.config.platforms.feishu;
        const openId = feishu.me.openId ?? feishu.approvers[0]?.openId;
        if (!openId)
            return;
        this.resolvedOwner = {
            platform: "feishu",
            openId,
            ...(feishu.me.name ?? feishu.approvers[0]?.name
                ? { displayName: feishu.me.name ?? feishu.approvers[0]?.name }
                : {}),
            boundAt: Date.now(),
            method: "config",
        };
    }
    reconcileOwner() {
        const stored = this.owners.get("feishu");
        if (!this.resolvedOwner && stored) {
            this.resolvedOwner = stored;
            return;
        }
        if (!stored && this.resolvedOwner) {
            this.owners.set(this.resolvedOwner);
            return;
        }
        if (stored && this.resolvedOwner && stored.openId !== this.resolvedOwner.openId) {
            this.logger.warn("configured owner differs from persisted owner; using config", {
                configured: this.resolvedOwner.openId,
                persisted: stored.openId,
            });
            this.owners.set(this.resolvedOwner);
        }
    }
    ownerOpenId() {
        return this.resolvedOwner?.openId ?? this.config.platforms.feishu.me.openId ?? this.config.platforms.feishu.approvers[0]?.openId;
    }
    ownerName() {
        return (this.resolvedOwner?.displayName ??
            this.config.platforms.feishu.me.name ??
            this.config.filter.profile.name ??
            "我");
    }
    async claimOwner(message) {
        const bootstrap = this.config.platforms.feishu.bootstrap;
        if (!bootstrap.allowPrivateClaim)
            return false;
        const claimCode = this.options.loaded.secrets.claimCode;
        if (!claimCode)
            return false;
        if (message.chat.kind !== "direct")
            return false;
        const expected = claimCode.trim();
        const provided = message.text.trim();
        if (!expected || provided !== expected) {
            this.recordClaimAttempt(message.sender.id);
            return false;
        }
        if (this.tooManyClaimAttempts(message.sender.id)) {
            await this.sendToOwner("claim 尝试过于频繁，已暂时拒绝。");
            return false;
        }
        const existing = this.resolvedOwner ?? this.owners.get(message.platform);
        if (existing && existing.openId !== message.sender.id) {
            await this.audit.append({
                actor: message.sender,
                action: "owner_claim_rejected",
                details: { reason: "owner already bound", existing: existing.openId },
            });
            await this.sendToOwner("owner 已绑定，不能通过 claim 覆盖；如需更换请重新生成 claim code 并清空 owner.json。");
            return false;
        }
        const binding = {
            platform: message.platform,
            openId: message.sender.id,
            ...(message.sender.displayName ? { displayName: message.sender.displayName } : {}),
            boundAt: Date.now(),
            method: "claim",
        };
        this.owners.set(binding);
        await this.owners.flush();
        this.resolvedOwner = binding;
        this.claimAttempts.delete(message.sender.id);
        await this.audit.append({
            actor: message.sender,
            action: "owner_claimed",
            details: { method: "claim" },
        });
        await this.sendToOwner(`已绑定你为 owner：${message.sender.displayName ?? message.sender.id}。后续 @、升级、审批都发给你。`);
        return true;
    }
    recordClaimAttempt(senderId) {
        const now = Date.now();
        const entry = this.claimAttempts.get(senderId);
        if (!entry || now - entry.firstAt > 600_000) {
            this.claimAttempts.set(senderId, { count: 1, firstAt: now });
            return;
        }
        entry.count += 1;
    }
    tooManyClaimAttempts(senderId) {
        const entry = this.claimAttempts.get(senderId);
        if (!entry)
            return false;
        if (Date.now() - entry.firstAt > 600_000) {
            this.claimAttempts.delete(senderId);
            return false;
        }
        return entry.count > this.config.platforms.feishu.bootstrap.maxClaimAttemptsPer10Min;
    }
    async sendToOwner(text) {
        const openId = this.ownerOpenId();
        if (!openId)
            return false;
        try {
            await this.sendLimiter.take();
            await this.options.platform.send({ kind: "user", userId: openId }, { kind: "text", text, uuid: stableUuid("owner", openId, sha256(text).slice(0, 16)) });
            return true;
        }
        catch (error) {
            this.logger.error("failed to send to owner", { error: toErrorMessage(error) });
            return false;
        }
    }
    track(promise) {
        this.background.add(promise);
        promise.finally(() => this.background.delete(promise)).catch(() => { });
        return promise;
    }
    async drainBackground(timeoutMs = 5000) {
        if (this.background.size === 0)
            return;
        const pending = Promise.allSettled([...this.background]);
        await Promise.race([
            pending,
            new Promise((resolve) => setTimeout(resolve, timeoutMs)),
        ]);
    }
    sweepTimer;
    async start() {
        if (this.started)
            return;
        await this.dedup.load();
        await this.outbound.load();
        await this.cursors.load();
        await this.sessions.load();
        await this.tasks.load();
        await this.pending.load();
        await this.projectStore.load();
        await this.chatContext.load();
        await this.memory.load();
        await this.memory.migrateShards();
        await this.groupContext.load();
        this.evidence.prune();
        await this.owners.load();
        this.reconcileOwner();
        await this.options.platform.start({
            onMessage: (message) => this.onMessage(message),
            onAction: (action) => this.onAction(action),
            onChatMembership: (event) => this.onChatMembership(event),
        });
        this.poller.start();
        this.sweepTimer = setInterval(() => {
            void this.sweepExpiredApprovals();
            void this.sweepSessions();
            void this.chatContext.flush();
            void this.memory.flush();
        }, 60_000);
        this.sweepTimer.unref?.();
        void this.sweepExpiredApprovals();
        this.started = true;
        setImmediate(() => {
            void this.recoverOnStartup().catch((error) => {
                this.logger.error("startup recovery failed", { error: toErrorMessage(error) });
            });
        });
        this.logger.info("runtime started", {
            platform: this.options.platform.platform,
            groups: [...this.groupIds],
            projectMode: this.config.project.mode,
            projectAllowlist: this.config.project.allowlist,
            mentionConcurrency: this.config.concurrency.mentionConcurrency,
            scanConcurrency: this.config.concurrency.scanConcurrency,
        });
    }
    async stop() {
        if (!this.started)
            return;
        this.started = false;
        if (this.sweepTimer)
            clearInterval(this.sweepTimer);
        this.sweepTimer = undefined;
        this.poller.stop();
        await this.dispatcher.close(5000);
        await this.drainBackground();
        await this.options.platform.stop();
        await Promise.all([
            this.dedup.close(),
            this.outbound.close(),
            this.cursors.flush(),
            this.sessions.flush(),
            this.tasks.close(),
            this.pending.flush(),
            this.projectStore.flush(),
            this.chatContext.flush(),
            this.memory.flush(),
            this.groupContext.flush(),
            this.owners.flush(),
        ]);
        this.logger.info("runtime stopped");
    }
    async onMessage(message, wait = false) {
        if (message.senderType !== "user")
            return;
        const chatName = await this.chatLabel(message);
        this.logger.info("inbound routing", {
            messageId: message.messageId,
            chatId: message.chat.id,
            chatName,
            chatKind: message.chat.kind,
            senderId: message.sender.id,
            mentionMe: this.isMentionMe(message),
            mentionBot: this.isMentionBot(message),
            allowlisted: this.groupIds.has(message.chat.id),
            textPreview: redactPreview(message.text),
        });
        if (message.chat.kind === "direct") {
            if (await this.claimOwner(message)) {
                await this.markProcessed(message);
                return;
            }
            await this.handleDirectMessage(message);
            return;
        }
        if (this.config.policy.defaultDenyGroups && !this.groupIds.has(message.chat.id)) {
            this.logger.info("ignoring message from group not in allowlist", {
                chatId: message.chat.id,
                chatName,
                messageId: message.messageId,
                mentionMe: this.isMentionMe(message),
                mentionBot: this.isMentionBot(message),
            });
            return;
        }
        const dedupKey = `${message.platform}:${message.messageId}`;
        if (this.dedup.has(dedupKey) || this.activeMessageIds.has(dedupKey))
            return;
        this.activeMessageIds.add(dedupKey);
        this.rememberRecent(message);
        const mention = this.isMention(message);
        const mentionBot = this.isMentionBot(message);
        const ownerId = this.ownerOpenId();
        const fromOwner = Boolean(ownerId) && message.sender.id === ownerId;
        const limited = mentionBot && !(this.config.botReply.ownerBypass && fromOwner);
        if (limited && !this.senderLimiter.tryAcquire(message.sender.id)) {
            if (this.senderLimiter.shouldWarn(message.sender.id)) {
                this.logger.warn("sender rate limited; sending one warning", {
                    senderId: message.sender.id,
                    messageId: message.messageId,
                });
                await this.safeReply(message, this.config.botReply.overloadReply);
            }
            this.dedup.add(dedupKey);
            await this.dedup.flush();
            return;
        }
        const mentionMe2 = this.isMentionMe(message);
        const storeOwnerGroup = fromOwner && this.config.context.enabled && this.config.context.storeOwnerGroup !== false;
        const storeAllGroup = this.config.context.storeAllGroupMessages !== false && !isLowValueMessage(message.text);
        if (this.shouldStoreContext(message, mentionMe2, mentionBot) || storeOwnerGroup || storeAllGroup) {
            const origin = mentionBot
                ? "mention_bot"
                : mentionMe2
                    ? "mention_me"
                    : fromOwner
                        ? "owner_group"
                        : this.isMediaMessage(message)
                            ? "media_placeholder"
                            : "group_all";
            this.chatContext.append(`${message.platform}:${message.chat.id}`, {
                messageId: message.messageId,
                senderId: message.sender.id,
                ...(message.sender.displayName ? { senderName: message.sender.displayName } : {}),
                text: message.text,
                at: message.createdAt,
                ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
                ...(message.threadId ? { threadId: message.threadId } : {}),
                mentionMe: mentionMe2,
                mentionBot,
                origin,
            }, {
                platform: message.platform,
                chatId: message.chat.id,
                ...(message.chat.name ? { chatName: message.chat.name } : {}),
            });
            this.evidence.append({
                ts: message.createdAt,
                platform: message.platform,
                chatId: message.chat.id,
                ...(message.chat.name ? { chatName: message.chat.name } : {}),
                messageId: message.messageId,
                direction: "inbound",
                senderId: message.sender.id,
                ...(message.sender.displayName ? { senderName: message.sender.displayName } : {}),
                origin,
                text: message.text,
                ...(message.attachments ? { attachments: message.attachments } : {}),
            });
        }
        if (this.config.groupSession?.enabled !== false) {
            void this.updateGroupSummary(message.platform, message.chat.id);
        }
        const job = this.dispatcher.enqueue({
            id: message.messageId,
            key: message.chat.id,
            priority: mention ? 1 : 5,
            keyConcurrency: mention
                ? Math.max(this.config.concurrency.perChat, this.config.concurrency.mentionConcurrency)
                : this.config.concurrency.scanConcurrency,
            timeoutMs: mention
                ? this.config.concurrency.mentionTimeoutMs
                : this.config.concurrency.scanTimeoutMs,
            run: async (signal) => {
                try {
                    await this.handleMessage(message, signal);
                }
                finally {
                    this.activeMessageIds.delete(dedupKey);
                    if (limited)
                        this.senderLimiter.release(message.sender.id);
                }
            },
        });
        if (wait) {
            try {
                await job;
            }
            catch (error) {
                this.activeMessageIds.delete(dedupKey);
                if (limited)
                    this.senderLimiter.release(message.sender.id);
                this.logger.error("failed to process message", {
                    messageId: message.messageId,
                    error: toErrorMessage(error),
                });
                throw error;
            }
            return;
        }
        void job.catch((error) => {
            this.activeMessageIds.delete(dedupKey);
            if (limited)
                this.senderLimiter.release(message.sender.id);
            this.logger.error("failed to process message", {
                messageId: message.messageId,
                error: toErrorMessage(error),
            });
        });
    }
    async ingest(message) {
        await this.onMessage(message, true);
    }
    async ingestBatch(messages) {
        await this.handlePolledBatch(messages);
    }
    isMention(message) {
        const me = this.ownerOpenId();
        const bot = this.options.platform.platform === "feishu"
            ? this.options.platform.getBotOpenId?.() ??
                this.config.platforms.feishu.botOpenId
            : this.config.platforms.feishu.botOpenId;
        return message.mentions.some((mention) => mention.id === me || (bot && mention.id === bot));
    }
    isMentionMe(message) {
        const me = this.ownerOpenId();
        return Boolean(me) && message.mentions.some((mention) => mention.id === me);
    }
    isMentionBot(message) {
        const bot = this.options.platform
            .getBotOpenId?.() ?? this.config.platforms.feishu.botOpenId;
        return Boolean(bot) && message.mentions.some((mention) => mention.id === bot);
    }
    async onChatMembership(event) {
        if (event.change === "bot_removed") {
            this.logger.info("bot removed from chat", {
                chatId: event.chatId,
                actorId: event.actorId,
            });
            return;
        }
        const name = (await this.fetchChatName(event.chatId)) ?? event.chatId;
        this.chatNames.set(event.chatId, { name, at: Date.now() });
        this.groupIds.add(event.chatId);
        this.logger.info("bot added to chat", {
            chatId: event.chatId,
            chatName: name,
            actorId: event.actorId,
            allowlisted: true,
        });
        await this.sendToOwner(`机器人已被加入群：${name}\nchat_id：${event.chatId}\n已自动加入处理白名单；重启后仍生效需写入配置（atme-proxy chats --sync）。`);
        await this.audit.append({
            actor: { system: true },
            action: "bot_added_to_chat",
            details: { chatId: event.chatId, chatName: name, actorId: event.actorId },
        });
    }
    async fetchChatName(chatId) {
        const client = this.options.bridge.getClient?.();
        if (!client)
            return undefined;
        try {
            const response = await client.im.v1.chat.get({
                path: { chat_id: chatId },
            });
            if (typeof response?.data?.name === "string" && response.data.name) {
                return response.data.name;
            }
        }
        catch (error) {
            this.logger.debug("chat.get failed; trying raw request", {
                chatId,
                error: toErrorMessage(error),
            });
        }
        try {
            const raw = await client.request({
                method: "GET",
                url: `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`,
            });
            if (typeof raw?.data?.name === "string" && raw.data.name)
                return raw.data.name;
        }
        catch (error) {
            this.logger.debug("raw chat lookup failed", {
                chatId,
                error: toErrorMessage(error),
            });
        }
        return undefined;
    }
    async chatLabel(message) {
        const chatId = message.chat.id;
        const cached = this.chatNames.get(chatId);
        if (cached && Date.now() - cached.at < 6 * 3600_000)
            return cached.name;
        if (message.chat.name) {
            this.chatNames.set(chatId, { name: message.chat.name, at: Date.now() });
            return message.chat.name;
        }
        const configured = this.config.platforms.feishu.groups.find((group) => group.chatId === chatId);
        if (configured?.name && configured.name !== chatId) {
            this.chatNames.set(chatId, { name: configured.name, at: Date.now() });
            return configured.name;
        }
        const name = await this.fetchChatName(chatId);
        if (name) {
            this.chatNames.set(chatId, { name, at: Date.now() });
            return name;
        }
        return chatId;
    }
    handleOwnerCommand(message, command) {
        return this.ownerCommandService.handle(message, command);
    }
    async handleDirectMessage(message) {
        if (!this.config.directChat.enabled)
            return;
        const ownerId = this.ownerOpenId();
        if (this.config.directChat.onlyOwner && ownerId && message.sender.id !== ownerId) {
            this.logger.info("ignoring direct message from non-owner", {
                senderId: message.sender.id,
            });
            return;
        }
        const dedupKey = `${message.platform}:${message.messageId}`;
        if (this.dedup.has(dedupKey) || this.activeMessageIds.has(dedupKey))
            return;
        this.activeMessageIds.add(dedupKey);
        const command = parseOwnerCommand(message.text);
        if (command) {
            try {
                const reply = await this.handleOwnerCommand(message, command);
                await this.safeReply(message, reply);
            }
            catch (error) {
                this.logger.error("owner command failed", {
                    command: command.command,
                    error: toErrorMessage(error),
                });
                await this.safeReply(message, `命令失败：${toErrorMessage(error)}`);
            }
            finally {
                this.activeMessageIds.delete(dedupKey);
            }
            await this.markProcessed(message);
            return;
        }
        if (this.config.context.enabled && this.config.context.storeOwnerDm) {
            this.chatContext.append(`${message.platform}:${message.chat.id}`, {
                messageId: message.messageId,
                senderId: message.sender.id,
                ...(message.sender.displayName ? { senderName: message.sender.displayName } : {}),
                text: message.text,
                at: message.createdAt,
                mentionMe: false,
                mentionBot: false,
                origin: "owner_dm",
            }, {
                platform: message.platform,
                chatId: message.chat.id,
                ...(message.chat.name ? { chatName: message.chat.name } : {}),
            });
        }
        const job = this.dispatcher.enqueue({
            id: `dm:${message.messageId}`,
            key: `dm:${message.chat.id}`,
            priority: 1,
            keyConcurrency: 1,
            timeoutMs: this.config.concurrency.mentionTimeoutMs,
            run: async (signal) => {
                try {
                    const style = detectReplyStyle(message, this.replyOptions);
                    const reply = await this.askOpenCode(message, style, signal);
                    const ok = await this.safeReply(message, this.sanitize(reply));
                    if (ok)
                        await this.markProcessed(message);
                    await this.audit.append({
                        actor: message.sender,
                        action: "direct_message_replied",
                        details: { messageId: message.messageId },
                    });
                }
                finally {
                    this.activeMessageIds.delete(dedupKey);
                }
            },
        });
        try {
            await job;
        }
        catch (error) {
            this.activeMessageIds.delete(dedupKey);
            this.logger.error("direct message failed", {
                messageId: message.messageId,
                error: toErrorMessage(error),
            });
            await this.safeReply(message, `处理失败：${toErrorMessage(error)}\n请检查 opencode serve 是否运行，或稍后重试。`);
        }
    }
    recentKey(message) {
        return `${message.platform}:${message.chat.id}:${message.sender.id}`;
    }
    rememberRecent(message) {
        if (!this.config.context.burstGrouping)
            return;
        const key = this.recentKey(message);
        const list = this.recentMessages.get(key) ?? [];
        list.push(message);
        const cutoff = Date.now() - 5 * 60_000;
        const trimmed = list.filter((item) => item.createdAt >= cutoff).slice(-20);
        this.recentMessages.set(key, trimmed);
        while (this.recentMessages.size > 500) {
            const oldest = this.recentMessages.keys().next().value;
            if (oldest === undefined)
                break;
            this.recentMessages.delete(oldest);
        }
    }
    collectBurst(message) {
        if (!this.config.context.burstGrouping)
            return [];
        const key = this.recentKey(message);
        const all = this.recentMessages.get(key) ?? [];
        const windowMs = this.config.context.burstWindowSeconds * 1000;
        const result = [];
        let lastAt = message.createdAt;
        let chars = 0;
        for (const item of all) {
            if (item.messageId === message.messageId)
                continue;
            if (item.chat.id !== message.chat.id)
                continue;
            if (item.sender.id !== message.sender.id)
                continue;
            if (item.createdAt <= message.createdAt)
                continue;
            if (item.createdAt - lastAt > windowMs)
                break;
            if (result.length >= this.config.context.burstMaxMessages)
                break;
            chars += item.text.length;
            if (chars > this.config.context.burstMaxChars)
                break;
            result.push(item);
            lastAt = item.createdAt;
        }
        return result;
    }
    async waitForBurst(message, signal) {
        if (!this.config.context.burstGrouping)
            return;
        const waitMs = this.config.context.burstWaitMs;
        if (signal.aborted)
            return;
        await new Promise((resolve) => {
            const timer = setTimeout(resolve, waitMs);
            timer.unref?.();
            signal.addEventListener("abort", () => {
                clearTimeout(timer);
                resolve();
            }, { once: true });
        });
    }
    async applyBurstGrouping(message, signal) {
        const candidates = this.collectBurst(message);
        if (candidates.length === 0)
            return [];
        const decision = await selectBurstExtensions(this.llm, message, candidates);
        if (decision.usedFallback) {
            this.logger.warn("burst grouping fell back; keeping followups together", {
                base: message.messageId,
                candidates: candidates.length,
            });
        }
        if (decision.rejected.length > 0) {
            this.logger.info("burst grouping rejected unrelated followups", {
                base: message.messageId,
                rejected: decision.rejected.map((item) => item.messageId),
            });
        }
        return decision.selected;
    }
    async handleMessage(message, signal) {
        const mentionMe = this.isMentionMe(message);
        const mentionBot = this.isMentionBot(message);
        if (mentionBot) {
            await this.handleBotMention(message, signal);
            return;
        }
        if (mentionMe) {
            await this.handleMeMention(message, signal);
            return;
        }
        if (this.pollingEnabled)
            return;
        await this.handleGroupScan(message, signal);
    }
    async handleBotMention(message, signal) {
        const enriched = message;
        const intent = await this.decideBotIntent(enriched, signal);
        if (intent.action === "no_reply") {
            this.logger.info("bot mention skipped by necessity check", {
                messageId: message.messageId,
                reason: intent.reason,
                confidence: intent.confidence,
            });
            await this.markProcessed(message);
            await this.audit.append({
                actor: { system: true },
                action: "bot_mention_skipped",
                details: { messageId: message.messageId, reason: intent.reason },
            });
            return;
        }
        if (intent.action === "notify_owner") {
            const notified = await this.sendOwnerDecisionCard(message, intent, "notify");
            this.rememberFromMention(message, intent);
            if (notified)
                await this.markProcessed(message);
            await this.audit.append({
                actor: { system: true },
                action: "bot_mention_owner_notified",
                details: { messageId: message.messageId, kind: intent.kind, reason: intent.reason },
            });
            return;
        }
        if (intent.action === "need_decision") {
            const analysis = await this.analyzeBotRequest(message, intent, signal);
            const escalated = await this.escalateToOwner(message, intent);
            const notified = await this.sendOwnerDecisionCard(message, intent, "decision", analysis);
            this.rememberFromMention(message, intent, analysis);
            if (escalated || notified)
                await this.markProcessed(message);
            await this.audit.append({
                actor: { system: true },
                action: "bot_mention_escalated",
                details: {
                    messageId: message.messageId,
                    kind: intent.kind,
                    reason: intent.reason,
                    analysisHash: analysis ? sha256(analysis).slice(0, 12) : undefined,
                },
            });
            return;
        }
        const style = intent.style;
        const ackTimer = this.config.reply.acknowledgeLongTasks
            ? setTimeout(() => {
                void this.safeReply(message, this.config.reply.ackText);
            }, this.config.reply.ackDelayMs)
            : undefined;
        if (ackTimer)
            ackTimer.unref?.();
        let replied = false;
        try {
            const reply = await this.askOpenCode(enriched, style, signal);
            if (ackTimer)
                clearTimeout(ackTimer);
            replied = await this.safeReply(message, this.sanitize(reply));
            this.rememberFromMention(message, intent, reply);
        }
        catch (error) {
            this.logger.error("bot mention handling failed", {
                messageId: message.messageId,
                error: toErrorMessage(error),
            });
            replied = await this.safeReply(message, "处理失败，请稍后重试或直接联系我。");
        }
        finally {
            if (ackTimer)
                clearTimeout(ackTimer);
        }
        if (replied)
            await this.markProcessed(message);
        await this.audit.append({
            actor: { system: true },
            action: "bot_mention_replied",
            details: { messageId: message.messageId, style, reason: intent.reason },
        });
    }
    async decideBotIntent(message, signal) {
        if (!this.config.botReply.enabled) {
            return {
                action: "answer",
                kind: "question",
                style: detectReplyStyle(message, this.replyOptions),
                confidence: 1,
                reason: "necessity check disabled",
            };
        }
        if (!this.config.filter.enabled) {
            const trivial = /^(谢谢|收到|好的| ok|ok|测试一下|test)[！!。.\s]*$/i.test(message.text.trim());
            return {
                action: trivial ? "no_reply" : "answer",
                kind: trivial ? "chat" : "question",
                style: detectReplyStyle(message, this.replyOptions),
                confidence: 0.5,
                reason: trivial ? "寒暄/确认，无需回复" : "未启用筛选模型，按普通问题回答",
            };
        }
        const recent = this.config.context.enabled
            ? this.chatContext
                .recent(`${message.platform}:${message.chat.id}`, 6, message.messageId)
                .map((item) => `${item.senderName ?? item.senderId}: ${truncate(item.text, 160)}`)
            : [];
        try {
            const completion = await this.llm.complete(buildBotIntentPrompt({
                text: message.text,
                history: recent,
                profile: {
                    name: this.config.filter.profile.name,
                    role: this.config.filter.profile.role,
                    keywords: this.config.filter.profile.keywords,
                    projects: this.config.filter.profile.projects,
                    tasks: this.config.filter.profile.tasks,
                },
                allowNoReply: this.config.botReply.allowNoReply,
            }), signal);
            const intent = parseBotIntent(completion.text, {
                text: message.text,
                history: recent,
                profile: {
                    name: this.config.filter.profile.name,
                    role: this.config.filter.profile.role,
                    keywords: this.config.filter.profile.keywords,
                    projects: this.config.filter.profile.projects,
                    tasks: this.config.filter.profile.tasks,
                },
                allowNoReply: this.config.botReply.allowNoReply,
            });
            if (intent.action === "answer" &&
                intent.confidence < this.config.botReply.minAnswerConfidence) {
                return {
                    ...intent,
                    action: this.config.botReply.escalateWhenUnsure ? "need_decision" : "no_reply",
                    reason: `${intent.reason} (low confidence ${intent.confidence.toFixed(2)})`,
                };
            }
            return intent;
        }
        catch (error) {
            this.logger.warn("bot intent classification failed", {
                messageId: message.messageId,
                error: toErrorMessage(error),
            });
            return {
                action: this.config.botReply.escalateWhenUnsure ? "need_decision" : "no_reply",
                kind: "other",
                style: detectReplyStyle(message, this.replyOptions),
                confidence: 0,
                reason: "intent classification failed",
            };
        }
    }
    async analyzeBotRequest(message, intent, signal) {
        if (!this.config.botReply.analyzeBeforeEscalate)
            return undefined;
        try {
            const project = await this.resolveProject(message.chat.id);
            const prompt = [
                "你是研发任务助手。请对下面这个群里的请求做简短可行性分析，供主人决策。",
                "只输出 3-5 行：请求实质、影响范围、建议做/不做/先确认什么、风险。",
                "不要执行代码，不要承诺排期，不要编造。",
                `消息类型：${intent.kind}`,
                `发送人：${message.sender.displayName ?? message.sender.id}`,
                `内容：${message.text}`,
                `当前项目目录：${project.worktree}`,
            ].join("\n");
            const { sessionId, release } = await this.createChildSession({
                platform: message.platform,
                chatId: message.chat.id,
                directory: project.worktree,
                title: `${this.config.opencode.sessionTitlePrefix}:analyze:${message.messageId}`,
                role: "analysis",
                permission: READ_ONLY_PERMISSION,
                signal,
            });
            try {
                const raw = await this.options.bridge.prompt(sessionId, {
                    directory: project.worktree,
                    title: `${this.config.opencode.sessionTitlePrefix}:analyze:${message.messageId}`,
                    text: prompt,
                    signal,
                });
                return truncate(raw.trim(), 600);
            }
            finally {
                release();
                await this.finishSession(sessionId, `${this.config.opencode.sessionTitlePrefix}:analyze:${message.messageId}`, project.worktree, "bot_request_analysis");
            }
        }
        catch (error) {
            this.logger.warn("bot request analysis failed", {
                messageId: message.messageId,
                error: toErrorMessage(error),
            });
            return undefined;
        }
    }
    async sendOwnerDecisionCard(message, intent, mode, analysis) {
        const text = [
            mode === "decision" ? "群里有人 @机器人，需要你判断是否要做" : "群里有人 @机器人，仅需你知会",
            `类型：${intent.kind}`,
            `来源：${message.chat.name ?? message.chat.id} / ${message.sender.displayName ?? message.sender.id}`,
            `内容：${truncate(intent.summary ?? message.text, 240)}`,
            `判断：${intent.reason}`,
            ...(intent.suggestedAction ? [`建议：${intent.suggestedAction}`] : []),
            ...(analysis ? [`分析：\n${analysis}`] : []),
        ].join("\n");
        return this.sendToOwner(text);
    }
    async escalateToOwner(message, intent) {
        const question = intent.question
            ? truncate(intent.question, this.config.botReply.maxQuestionChars)
            : truncate(message.text, this.config.botReply.maxQuestionChars);
        const text = [
            this.config.botReply.decisionMentionText,
            `类型：${intent.kind}`,
            `问题：${question}`,
            `来源：${message.sender.displayName ?? message.sender.id}`,
            `原因：${intent.reason || "需要你本人决策"}`,
            ...(intent.suggestedAction ? [`建议：${intent.suggestedAction}`] : []),
        ].join("\n");
        try {
            await this.sendLimiter.take();
            await this.options.platform.reply({ chatId: message.chat.id, messageId: message.messageId }, {
                kind: "text",
                text,
                uuid: stableUuid("escalate", message.messageId),
                mentions: [
                    {
                        id: this.ownerOpenId() ?? "",
                        name: this.ownerName(),
                    },
                ].filter((mention) => mention.id),
            });
            return true;
        }
        catch (error) {
            this.logger.error("failed to escalate to owner in group", {
                messageId: message.messageId,
                error: toErrorMessage(error),
            });
            return this.sendToApprover(text);
        }
    }
    async handleMeMention(message, signal) {
        await this.waitForBurst(message, signal);
        const burst = await this.applyBurstGrouping(message, signal);
        const enriched = mergeBurst(message, burst);
        const classification = await this.classifyOne(enriched, signal);
        if (classification?.actionability === "task" &&
            classification.confidence >= this.config.filter.minTaskConfidence) {
            const task = await this.ensureTask(enriched, classification, "mention_me");
            if (task) {
                await this.markProcessed(message);
                for (const followup of burst)
                    await this.markProcessed(followup);
                return;
            }
        }
        const style = detectReplyStyle(enriched, this.replyOptions);
        const depth = detectReplyDepth(enriched, this.replyOptions);
        const decision = await this.shouldReplyToMention(enriched, classification);
        if (!decision.reply) {
            this.logger.info("mention skipped by reply necessity", {
                messageId: message.messageId,
                reason: decision.reason,
            });
            await this.markProcessed(message);
            for (const followup of burst)
                await this.markProcessed(followup);
            await this.audit.append({
                actor: { system: true },
                action: "mention_skipped",
                details: { messageId: message.messageId, reason: decision.reason },
            });
            return;
        }
        const task = await this.createReplyTask(enriched, classification);
        const autoReply = this.config.policy.autoReplyOnMention &&
            classification?.actionability !== "task" &&
            (classification?.confidence ?? 0) >= this.config.filter.minTaskConfidence;
        if (autoReply) {
            try {
                const reply = depth === "ack"
                    ? "收到"
                    : await this.askOpenCode(enriched, style, signal, depth);
                const replied = await this.safeReply(message, `${ASSISTANT_LABEL} ${this.sanitize(reply)}`);
                if (!replied)
                    throw new Error("reply failed");
                task.state = "done";
                task.updatedAt = Date.now();
                await this.tasks.save(task);
                await this.audit.append({
                    actor: { system: true },
                    action: "mention_auto_replied",
                    taskId: task.id,
                    details: { messageId: message.messageId, style },
                });
                await this.markProcessed(message);
                return;
            }
            catch (error) {
                this.logger.error("auto reply failed; falling back to approval", {
                    taskId: task.id,
                    error: toErrorMessage(error),
                });
            }
        }
        try {
            await this.sendReplyApproval(task, message, enriched, depth);
            await this.markProcessed(message);
            for (const followup of burst)
                await this.markProcessed(followup);
        }
        catch (error) {
            this.logger.error("failed to send reply approval", {
                taskId: task.id,
                error: toErrorMessage(error),
            });
            const notified = await this.sendToApprover(`有人 @你，但审批卡发送失败：${truncate(message.text, 200)}\n发送人：${message.sender.displayName ?? message.sender.id}`);
            if (notified)
                await this.markProcessed(message);
        }
    }
    shouldReplyToMention(message, classification) {
        return this.replyService.shouldReplyToMention(message, classification);
    }
    createReplyTask(message, classification) {
        return this.replyService.createReplyTask(message, classification);
    }
    sendReplyApproval(task, message, draftSource = message, depth = "answer") {
        return this.replyService.sendReplyApproval(task, message, draftSource, depth);
    }
    async handlePolledBatch(messages) {
        let failed = false;
        const candidates = messages.filter((message) => {
            if (message.senderType !== "user")
                return false;
            if (message.chat.kind !== "group")
                return false;
            if (this.config.policy.defaultDenyGroups && !this.groupIds.has(message.chat.id))
                return false;
            return true;
        });
        if (candidates.length === 0)
            return;
        for (const message of candidates) {
            if (!this.isMention(message))
                continue;
            try {
                await this.onMessage(message, true);
            }
            catch (error) {
                failed = true;
                this.logger.error("polled mention handling failed", {
                    messageId: message.messageId,
                    error: toErrorMessage(error),
                });
            }
        }
        const plain = candidates.filter((message) => !this.isMention(message));
        if (plain.length === 0)
            return;
        const fresh = plain.filter((message) => {
            const key = `${message.platform}:${message.messageId}`;
            return !this.dedup.has(key) && !this.activeMessageIds.has(key);
        });
        if (fresh.length === 0)
            return;
        const perSender = new Map();
        const capped = fresh.filter((message) => {
            const count = (perSender.get(message.sender.id) ?? 0) + 1;
            if (count > this.config.botReply.maxMessagesPerSenderPerRun)
                return false;
            perSender.set(message.sender.id, count);
            return true;
        });
        if (capped.length < fresh.length) {
            this.logger.warn("per-sender message cap applied", {
                dropped: fresh.length - capped.length,
            });
        }
        for (const message of capped) {
            this.activeMessageIds.add(`${message.platform}:${message.messageId}`);
        }
        const chatId = capped[0]?.chat.id ?? "unknown";
        const budget = this.config.budget.maxMessagesPerRun;
        const limitedMessages = capped.slice(0, budget);
        if (limitedMessages.length < capped.length) {
            await this.sendToApprover(`本轮消息超过预算，仅处理 ${limitedMessages.length}/${capped.length} 条；剩余留待下一轮。`);
            failed = true;
        }
        try {
            await this.dispatcher.enqueue({
                id: `scan:${chatId}:${limitedMessages[0]?.messageId ?? Date.now()}`,
                key: `${chatId}:scan`,
                keyConcurrency: this.config.concurrency.scanConcurrency,
                priority: 5,
                timeoutMs: this.config.concurrency.scanTimeoutMs,
                run: async (signal) => {
                    try {
                        await this.handlePolledBatchJob(limitedMessages, signal);
                    }
                    finally {
                        for (const message of capped) {
                            this.activeMessageIds.delete(`${message.platform}:${message.messageId}`);
                        }
                    }
                },
            });
        }
        catch (error) {
            for (const message of capped) {
                this.activeMessageIds.delete(`${message.platform}:${message.messageId}`);
            }
            this.logger.error("polled batch failed", {
                chatId,
                count: capped.length,
                error: toErrorMessage(error),
            });
            throw error;
        }
        if (failed) {
            throw new Error("polled batch had failed messages; cursor not advanced");
        }
    }
    async digestWithoutFilter(messages) {
        const usable = messages.filter((message) => message.senderType === "user" && message.text.trim().length > 0);
        if (usable.length === 0) {
            for (const message of messages)
                await this.markProcessed(message);
            return;
        }
        await this.sendOwnerDigest(usable, []);
        for (const message of messages)
            await this.markProcessed(message);
    }
    async sendOwnerDigest(messages, items) {
        const byId = new Map(items.map((item) => [item.messageId, item]));
        const lines = [];
        const related = [];
        for (const message of messages) {
            const item = byId.get(message.messageId);
            if (item?.relevant)
                related.push(message);
        }
        const highlighted = related.length > 0 ? related : messages.slice(0, 5);
        for (const message of highlighted.slice(0, 8)) {
            const item = byId.get(message.messageId);
            const sender = message.sender.displayName ?? message.sender.id;
            const time = formatLocalTime(message.createdAt);
            const reason = item?.reason ? `｜判断：${truncate(item.reason, 80)}` : "";
            const action = item?.actionability ? `｜类型：${item.actionability}` : "";
            lines.push([
                `• ${time} ${sender}${action}${reason}`,
                `  ${truncate(message.text.replace(/\s+/g, " "), 160)}`,
                `  message_id: ${message.messageId}`,
            ].join("\n"));
        }
        const summary = related.length > 0
            ? `与你相关 ${related.length} 条，共 ${messages.length} 条`
            : `本轮 ${messages.length} 条，未识别出强相关；下面是最近的`;
        await this.sendToOwner([`群消息分析：${summary}`, ...lines].join("\n\n"));
    }
    async handlePolledBatchJob(messages, signal) {
        if (!this.filterEnabled) {
            await this.digestWithoutFilter(messages);
            return;
        }
        const { items, stats } = await this.relevance.classify(messages, signal);
        if (stats.totalTokens > this.config.budget.maxTokensPerRun) {
            await this.sendToApprover(`本轮筛选 token 超预算：${stats.totalTokens}/${this.config.budget.maxTokensPerRun}，已停止后续批次。`);
        }
        if (stats.failures > 0) {
            const failed = stats.failedMessageIds;
            await this.sendToApprover(`筛选失败：${failed.length} 条消息未处理，已保留待重试。\n原因见日志；不会静默丢弃。`);
        }
        const byId = new Map(items.map((item) => [item.messageId, item]));
        const failed = new Set(stats.failedMessageIds);
        for (const message of messages) {
            if (failed.has(message.messageId))
                continue;
            const item = byId.get(message.messageId);
            if (!item?.relevant) {
                await this.markProcessed(message);
                continue;
            }
            this.appendContextForScan(message);
            if (item.actionability === "task" &&
                item.confidence >= this.config.filter.minTaskConfidence) {
                await this.ensureTask(message, item, "group_scan");
            }
            await this.markProcessed(message);
        }
        await this.sendOwnerDigest(messages, items);
        this.logger.info("polled batch classified", {
            chatId: messages[0]?.chat.id,
            messages: stats.messages,
            batches: stats.batches,
            tokens: stats.totalTokens,
            relevant: items.filter((item) => item.relevant).length,
        });
    }
    async handleGroupScan(message, signal) {
        const classification = await this.classifyOne(message, signal);
        if (!classification?.relevant)
            return;
        let handled = false;
        if (classification.actionability === "task" &&
            classification.confidence >= this.config.filter.minTaskConfidence) {
            const task = await this.ensureTask(message, classification, "group_scan");
            if (task)
                handled = true;
        }
        else {
            handled = await this.sendToApprover([
                "群消息可能与你相关",
                `群：${message.chat.name ?? message.chat.id}`,
                `发送人：${message.sender.displayName ?? message.sender.id}`,
                `内容：${truncate(message.text, 200)}`,
                `判断：${classification.reason}`,
                `建议：${suggestedActionLabel(classification.actionability)}`,
            ].join("\n"));
        }
        if (handled)
            await this.markProcessed(message);
    }
    async classifyOne(message, signal) {
        if (!this.filterEnabled)
            return undefined;
        try {
            const { items } = await this.relevance.classify([message], signal);
            return items.find((item) => item.messageId === message.messageId);
        }
        catch (error) {
            this.logger.error("classification failed; falling back to approval", {
                messageId: message.messageId,
                error: toErrorMessage(error),
            });
            return undefined;
        }
    }
    async ensureTask(message, classification, source) {
        const taskHint = classification?.task;
        const title = taskHint?.title ?? truncate(message.text.split("\n")[0] ?? message.text, 60);
        const dedupKey = makeDedupKey({
            platform: message.platform,
            chatId: message.chat.id,
            title,
            project: taskHint?.project,
            requesterId: message.sender.id,
        });
        const existingId = this.tasks.findByDedupKey(dedupKey);
        const now = Date.now();
        if (existingId) {
            const existing = await this.tasks.get(existingId);
            if (existing) {
                if (!existing.messageIds.includes(message.messageId)) {
                    existing.messageIds.push(message.messageId);
                    existing.updatedAt = now;
                    await this.tasks.save(existing);
                }
                return existing;
            }
        }
        const task = {
            id: `task_${sha256(`${dedupKey}:${message.messageId}`).slice(0, 12)}`,
            platform: message.platform,
            chatId: message.chat.id,
            ...(message.chat.name ? { chatName: message.chat.name } : {}),
            messageIds: message.messageIds ?? [message.messageId],
            source,
            requester: message.sender,
            title,
            excerpt: truncate(message.text, 500),
            ...(taskHint?.project ? { project: taskHint.project } : {}),
            ...(taskHint?.deadline ? { deadline: taskHint.deadline } : {}),
            keywords: this.config.filter.profile.keywords.filter((keyword) => message.text.includes(keyword)),
            relevance: {
                reason: classification?.reason ?? "mentioned",
                confidence: classification?.confidence ?? 1,
            },
            dedupKey,
            state: "analyzing",
            createdAt: now,
            updatedAt: now,
        };
        await this.tasks.save(task);
        await this.audit.append({
            actor: { system: true },
            action: "task_created",
            taskId: task.id,
            details: { source, messageId: message.messageId },
        });
        if (!this.config.policy.autoAnalyzeTasks) {
            task.state = "needs_info";
            task.updatedAt = Date.now();
            await this.tasks.save(task);
            await this.sendToApprover(`已记录任务，请回复补充信息或手动触发分析：${task.title}`);
            return task;
        }
        this.track(this.analyzeTask(task)).catch((error) => {
            this.logger.error("task analysis failed", {
                taskId: task.id,
                error: toErrorMessage(error),
            });
        });
        return task;
    }
    async analyzeTask(task) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error("analysis timed out")), this.config.concurrency.analysisTimeoutMs);
        let analysis;
        let verification;
        try {
            analysis = await this.buildAnalysis(task, controller.signal);
            verification = await this.verifyAnalysis(task, analysis, controller.signal);
            analysis.verification = verification;
            if (verification.drift === "major") {
                analysis.needsInfo = true;
                analysis.openQuestions = [
                    ...new Set([...analysis.openQuestions, ...verification.reasons]),
                ];
            }
        }
        finally {
            clearTimeout(timer);
        }
        await this.tasks.save(task);
        await writeJsonAtomic(join(this.stateDir, "analyses", task.id, `${analysis.version}.json`), analysis);
        await writeJsonAtomic(join(this.stateDir, "analyses", task.id, "index.json"), { version: analysis.version });
        this.rememberTaskOutcome(task, analysis);
        task.state = analysis.needsInfo ? "needs_info" : "awaiting_approval";
        task.updatedAt = Date.now();
        await this.tasks.save(task);
        await this.audit.append({
            actor: { system: true },
            action: "analysis_verified",
            taskId: task.id,
            details: {
                drift: verification?.drift ?? "unknown",
                unverified: verification?.unverifiedIdentifiers.length ?? 0,
            },
        });
        if (analysis.needsInfo) {
            await this.sendToApprover(`任务需要补充信息：${task.title}\n${analysis.openQuestions
                .map((question) => `- ${question}`)
                .join("\n")}`);
            return;
        }
        await this.sendApproval(task, analysis);
    }
    async buildAnalysis(task, signal) {
        const repo = this.config.repos[0];
        if (!repo) {
            const project = await this.resolveProject(task.chatId);
            if (!project.resolved) {
                return {
                    taskId: task.id,
                    version: 1,
                    needsInfo: true,
                    goal: task.title,
                    scope: [],
                    outOfScope: [],
                    repos: [],
                    plan: [],
                    commands: [],
                    risks: [],
                    openQuestions: ["未定位到当前主项目，请配置 project.worktree 或 repos"],
                    acceptanceCriteria: [],
                    model: "none",
                    createdAt: Date.now(),
                    planHash: "",
                };
            }
            return this.buildAnalysisInWorktree(task, project.worktree, signal);
        }
        const ctx = await this.analysisContext(task);
        const prompt = buildAnalysisPrompt({
            task,
            repositoryIds: this.config.repos.map((item) => item.id),
            directory: repo.path,
            context: ctx,
        });
        const analysisAgent = this.config.opencode.analysisAgent ?? this.config.opencode.agent;
        const raw = await this.runWorker({
            platform: task.platform,
            chatId: task.chatId,
            directory: repo.path,
            title: `${this.config.opencode.sessionTitlePrefix}:worker:analysis:${task.chatId}`,
            role: "analysis",
            permission: READ_ONLY_PERMISSION,
            ...(analysisAgent ? { agent: analysisAgent } : {}),
            ...(this.config.analysis.model ? { model: this.config.analysis.model } : {}),
        }, prompt, signal);
        return parseAnalysis(raw, task, repo.id);
    }
    async buildAnalysisInWorktree(task, worktree, signal) {
        const ctx = await this.analysisContext(task);
        const prompt = buildAnalysisPrompt({
            task,
            repositoryIds: this.config.repos.map((item) => item.id),
            directory: worktree,
            context: ctx,
        });
        const analysisAgent = this.config.opencode.analysisAgent ?? this.config.opencode.agent;
        const raw = await this.runWorker({
            platform: task.platform,
            chatId: task.chatId,
            directory: worktree,
            title: `${this.config.opencode.sessionTitlePrefix}:worker:analysis:${task.chatId}`,
            role: "analysis",
            permission: READ_ONLY_PERMISSION,
            ...(analysisAgent ? { agent: analysisAgent } : {}),
            ...(this.config.analysis.model ? { model: this.config.analysis.model } : {}),
        }, prompt, signal);
        return parseAnalysis(raw, task, "auto");
    }
    async createApprovalCard(task, source) {
        const analysis = await this.latestAnalysis(task.id);
        if (!analysis)
            return;
        await this.sendApproval(task, analysis);
        void source;
    }
    async sendApproval(task, analysis) {
        if (this.pending.get(`${task.id}:develop`) || this.pending.get(`${task.id}:reply`))
            return;
        const repo = this.config.repos.find((item) => analysis.repos.includes(item.id)) ?? this.config.repos[0];
        const view = {
            taskId: task.id,
            planHash: analysis.planHash,
            mode: "develop",
            title: task.title,
            summary: truncate(task.excerpt, 200),
            repo: repo?.id ?? "未配置",
            baseBranch: repo?.defaultBranch ?? "main",
            targetBranch: `atme/${task.id}`,
            commands: analysis.commands,
            risks: [
                ...analysis.risks,
                ...(analysis.verification?.reasons ?? []).map((reason) => `[核实] ${reason}`),
                ...(analysis.verification?.assumptions ?? []).map((item) => `[假设] ${item}`),
            ],
            acceptanceCriteria: analysis.acceptanceCriteria,
            openQuestions: analysis.openQuestions,
        };
        const message = this.options.platform.renderApproval(view);
        const ownerId = this.ownerOpenId();
        if (!ownerId)
            throw new Error("owner is not bound; cannot send approval card");
        const target = { kind: "user", userId: ownerId };
        await this.sendLimiter.take();
        const result = await this.options.platform.send(target, message);
        this.pending.set(`${task.id}:develop`, {
            platform: task.platform,
            taskId: task.id,
            analysisVersion: analysis.version,
            planHash: analysis.planHash,
            actorId: target.userId,
            mode: "develop",
            ...(result.messageId ? { messageId: result.messageId } : {}),
            chatId: task.chatId,
            createdAt: Date.now(),
        });
        await this.pending.flush();
    }
    async recoverOnStartup() {
        const recovery = this.config.recovery;
        if (!recovery.enabled)
            return;
        if (!this.started)
            return;
        if (recovery.resumeTasks) {
            await this.resumeOpenTasks();
        }
        if (recovery.onStartup) {
            await this.pullStartupWindow();
        }
    }
    async pullStartupWindow() {
        const recovery = this.config.recovery;
        if (!this.options.platform.capabilities().groupHistory) {
            this.logger.warn("recovery skipped: platform has no groupHistory capability");
            return;
        }
        const endTime = Date.now();
        const startTime = endTime - recovery.lookbackSeconds * 1000;
        this.logger.info("startup recovery pull", {
            startTime: new Date(startTime).toISOString(),
            endTime: new Date(endTime).toISOString(),
            groups: this.groupIds.size,
        });
        for (const chatId of this.groupIds) {
            try {
                const result = await this.options.platform.listMessages({
                    chatId,
                    startTime,
                    endTime,
                    maxPages: 20,
                    maxMessages: recovery.maxMessages,
                });
                if (result.messages.length === 0)
                    continue;
                const messageIds = result.messages.map((message) => `${message.platform}:${message.messageId}`);
                const unprocessed = result.messages.filter((message) => !this.dedup.has(`${message.platform}:${message.messageId}`));
                this.logger.info("startup recovery fetched", {
                    chatId,
                    fetched: result.messages.length,
                    unprocessed: unprocessed.length,
                    unique: new Set(messageIds).size,
                });
                if (unprocessed.length === 0)
                    continue;
                const mentions = recovery.includeMentions
                    ? unprocessed.filter((message) => this.isMention(message))
                    : [];
                for (const message of mentions) {
                    await this.ingest(message);
                }
                if (recovery.includeRelevantPlain) {
                    const plain = unprocessed
                        .filter((message) => !this.isMention(message))
                        .slice(-recovery.maxPlainMessagesPerGroup);
                    if (plain.length > 0)
                        await this.ingestBatch(plain);
                }
            }
            catch (error) {
                this.logger.error("startup recovery failed for group; continuing", {
                    chatId,
                    error: toErrorMessage(error),
                });
            }
        }
    }
    async resumeOpenTasks() {
        const recovery = this.config.recovery;
        const now = Date.now();
        const maxAgeMs = recovery.resumeMaxAgeDays * 86_400_000;
        const tasks = await this.tasks.list();
        let resumed = 0;
        let interrupted = 0;
        for (const task of tasks) {
            if (now - task.updatedAt > maxAgeMs)
                continue;
            if (task.state === "done" || task.state === "rejected" || task.state === "canceled") {
                continue;
            }
            if (task.state === "executing" || task.state === "verifying") {
                const staleMs = recovery.staleRunningMinutes * 60_000;
                if (now - task.updatedAt < staleMs)
                    continue;
                task.state = "awaiting_approval";
                task.updatedAt = now;
                await this.tasks.save(task);
                interrupted++;
                await this.sendToOwner(`上次执行被中断，已暂停等待你重新批准：${task.title}\n不会自动重放代码修改。`);
                continue;
            }
            if ((task.state === "awaiting_approval" || task.state === "needs_info") &&
                this.pending.findForTask(task.id)) {
                continue;
            }
            if (task.state === "candidate" || task.state === "analyzing") {
                task.state = "analyzing";
                task.updatedAt = now;
                await this.tasks.save(task);
                this.track(this.analyzeTask(task)).catch((error) => {
                    this.logger.error("resumed task analysis failed", {
                        taskId: task.id,
                        error: toErrorMessage(error),
                    });
                });
                resumed++;
                continue;
            }
            const nudgeMs = recovery.nudgeHours * 3600_000;
            if ((task.state === "awaiting_approval" || task.state === "needs_info") &&
                (nudgeMs === 0 || now - (task.lastNudgeAt ?? 0) > nudgeMs)) {
                task.lastNudgeAt = now;
                task.updatedAt = now;
                await this.tasks.save(task);
                await this.sendToOwner(`未完成任务提醒：${task.title}\n状态：${task.state}\n发送「查看任务」可列出详情（后续实现）。`);
                resumed++;
            }
        }
        this.logger.info("task resume finished", { resumed, interrupted });
        if (resumed > 0 || interrupted > 0) {
            await this.sendToOwner(`启动恢复：续作 ${resumed} 个未完成任务，中断 ${interrupted} 个执行。`);
        }
    }
    sweepExpiredApprovals() {
        return this.approvalService.sweepExpiredApprovals();
    }
    onAction(action) {
        return this.approvalService.onAction(action);
    }
    async approveReply(action, pending) {
        const task = await this.tasks.get(action.taskId);
        if (!task)
            return;
        const chatId = pending.chatId;
        const sourceMessageId = pending.sourceMessageId;
        if (!chatId || !sourceMessageId) {
            await this.sendToApprover("代答失败：缺少原消息信息");
            return;
        }
        const original = {
            platform: pending.platform,
            messageId: sourceMessageId,
            chat: { id: chatId, kind: "group" },
            sender: { platform: pending.platform, id: pending.actorId },
            senderType: "user",
            text: task.excerpt,
            mentions: [],
            createdAt: task.createdAt,
            rawType: "text",
        };
        const style = pending.style ?? this.replyOptions.defaultStyle;
        try {
            const reply = pending.draft
                ? enforceReplyLength(pending.draft, style, this.replyOptions)
                : await this.askOpenCode(original, style, new AbortController().signal);
            await this.safeReply(original, `${ASSISTANT_LABEL} ${this.sanitize(reply)}`);
            task.state = "done";
            task.updatedAt = Date.now();
            await this.tasks.save(task);
            await this.approvals.append({
                taskId: task.id,
                analysisVersion: pending.analysisVersion,
                planHash: pending.planHash,
                kind: "reply",
                decision: "approved",
                approvedBy: action.actor,
                decidedAt: Date.now(),
                createdAt: Date.now(),
            });
            await this.audit.append({
                actor: action.actor,
                action: "reply_approved",
                taskId: task.id,
                details: { messageId: sourceMessageId, style },
            });
            this.pending.deleteForTask(task.id);
            await this.pending.flush();
        }
        catch (error) {
            this.logger.error("approved reply failed", {
                taskId: task.id,
                error: toErrorMessage(error),
            });
            await this.sendToApprover(`代答失败：${task.title}\n${toErrorMessage(error)}`);
        }
    }
    async latestAnalysis(taskId) {
        const dir = join(this.stateDir, "analyses", taskId);
        const index = await readJsonFile(join(dir, "index.json"), undefined);
        const version = index?.version ?? 1;
        return readJsonFile(join(dir, `${version}.json`), undefined);
    }
    coordinatorSession(platform, chatId, directory, title) {
        return this.sessionManager.coordinatorSession(platform, chatId, directory, title);
    }
    runWorker(input, promptText, signal) {
        return this.sessionManager.runWorker(input, promptText, signal);
    }
    createChildSession(input) {
        return this.sessionManager.createChildSession(input);
    }
    archiveTaskChildren(taskId) {
        return this.sessionManager.archiveTaskChildren(taskId);
    }
    sweepSessions() {
        return this.sessionManager.sweepSessions();
    }
    finishSession(sessionId, title, directory, purpose) {
        return this.sessionManager.finishSession(sessionId, title, directory, purpose);
    }
    memoryBlock(platform, chatId, text) {
        return this.contextService.memoryBlock(platform, chatId, text);
    }
    rememberFromMention(message, intent, analysis) {
        if (!this.config.memory.enabled || !this.config.memory.extract)
            return;
        if (!this.config.memory.autoExtractFromMentions)
            return;
        const projectId = this.projectStore.get(message.chat.id)?.projectId;
        const base = {
            platform: message.platform,
            chatId: message.chat.id,
            ...(projectId ? { projectId } : {}),
            sourceMessageIds: [message.messageId],
            tags: [intent.kind, ...this.config.filter.profile.projects],
        };
        const summary = intent.summary ?? truncate(message.text, 160);
        const kind = intent.kind === "task"
            ? "task"
            : intent.action === "need_decision"
                ? "decision"
                : intent.kind === "reminder"
                    ? "deadline"
                    : "fact";
        this.memory.upsert({
            ...base,
            kind,
            key: `mention:${message.messageId}`,
            value: analysis ? `${summary}\n分析：${truncate(analysis, 400)}` : summary,
            confidence: intent.confidence,
        });
        if (analysis) {
            for (const line of analysis.split("\n")) {
                const trimmed = line.replace(/^[-*\d.、\s]+/, "").trim();
                if (trimmed.length < 6)
                    continue;
                if (/(建议|结论|风险|决定|决定做|不做|先确认)/.test(trimmed)) {
                    this.memory.upsert({
                        ...base,
                        kind: "decision",
                        key: `analysis:${message.messageId}:${sha256(trimmed).slice(0, 8)}`,
                        value: truncate(trimmed, 300),
                        confidence: intent.confidence,
                        pinned: false,
                    });
                }
            }
        }
        void this.memory.flush();
    }
    rememberTaskOutcome(task, analysis) {
        if (!this.config.memory.enabled || !this.config.memory.extract)
            return;
        if (!this.config.memory.autoExtractFromAnalysis)
            return;
        const projectId = this.projectStore.get(task.chatId)?.projectId;
        this.memory.upsert({
            platform: task.platform,
            chatId: task.chatId,
            ...(projectId ? { projectId } : {}),
            kind: "task",
            key: `task:${task.id}`,
            value: `${task.title}\n目标：${analysis.goal}\n验收：${analysis.acceptanceCriteria.join("；")}`,
            sourceMessageIds: task.messageIds,
            tags: ["task", ...(task.project ? [task.project] : []), ...task.keywords],
            confidence: 0.9,
        });
        if (analysis.openQuestions.length > 0) {
            this.memory.upsert({
                platform: task.platform,
                chatId: task.chatId,
                ...(projectId ? { projectId } : {}),
                kind: "decision",
                key: `task:${task.id}:open`,
                value: `待确认：${analysis.openQuestions.join("；")}`,
                sourceMessageIds: task.messageIds,
                tags: ["open_question"],
                confidence: 0.8,
            });
        }
        void this.memory.flush();
    }
    shouldStoreContext(message, mentionMe, mentionBot) {
        if (!this.config.context.enabled)
            return false;
        if (mentionMe || mentionBot)
            return this.config.context.storeMentions;
        if (this.config.context.storeMediaPlaceholders !== false && this.isMediaMessage(message)) {
            return true;
        }
        return false;
    }
    isMediaMessage(message) {
        if ((message.attachments?.length ?? 0) > 0)
            return true;
        return /\[(图片|文件|视频|音频)[^\]]*未解析\]/.test(message.text);
    }
    appendContextForScan(message) {
        if (!this.config.context.enabled || !this.config.context.storeRelevantScan)
            return;
        this.chatContext.append(`${message.platform}:${message.chat.id}`, {
            messageId: message.messageId,
            senderId: message.sender.id,
            ...(message.sender.displayName ? { senderName: message.sender.displayName } : {}),
            text: message.text,
            at: message.createdAt,
            ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
            ...(message.threadId ? { threadId: message.threadId } : {}),
            mentionMe: false,
            mentionBot: false,
            origin: "scan_relevant",
        }, {
            platform: message.platform,
            chatId: message.chat.id,
            ...(message.chat.name ? { chatName: message.chat.name } : {}),
        });
    }
    createGroupSession(platform, chatId, directory) {
        return this.sessionManager.createGroupSession(platform, chatId, directory);
    }
    summaryText(platform, chatId) {
        return this.contextService.summaryText(platform, chatId);
    }
    async updateGroupSummary(platform, chatId) {
        if (this.config.groupSession?.enabled === false)
            return;
        const key = `${platform}:${chatId}`;
        const previous = this.groupLocks.get(key) ?? Promise.resolve();
        const next = previous
            .then(() => this.doUpdateGroupSummary(platform, chatId))
            .catch((error) => {
            this.logger.warn("group summary update failed", {
                chatId,
                error: toErrorMessage(error),
            });
        });
        this.groupLocks.set(key, next);
        try {
            await next;
        }
        finally {
            if (this.groupLocks.get(key) === next)
                this.groupLocks.delete(key);
        }
    }
    async doUpdateGroupSummary(platform, chatId) {
        const every = this.config.groupSession?.summaryEveryMessages ?? 8;
        const maxChars = this.config.groupSession?.summaryMaxChars ?? 1500;
        const timeoutMs = this.config.groupSession?.timeoutMs ?? 30_000;
        const key = `${platform}:${chatId}`;
        const current = this.groupContext.get(key);
        const since = current?.lastMessageAt ?? 0;
        const messages = this.chatContext.recent(key, 50).filter((item) => item.at > since);
        if (messages.length < every)
            return;
        const directory = (await this.resolveProject(chatId)).worktree;
        const sessionId = await this.createGroupSession(platform, chatId, directory);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error("summary timed out")), timeoutMs);
        let raw;
        try {
            raw = await this.options.bridge.prompt(sessionId, {
                directory,
                title: `${this.config.opencode.sessionTitlePrefix}:group:${chatId}`,
                text: [
                    "你是群聊记录员。只维护摘要，不回答问题、不执行操作。",
                    "保留：已确认决策、被否决方案及原因、当前假设、未解决问题、关键表名/接口/字段。",
                    `合并现有摘要和新消息；去掉寒暄和重复；不超过 ${maxChars} 字。`,
                    '输出严格 JSON：{summary, decisions, assumptions, open_questions}。',
                    "现有摘要：",
                    current?.summary ?? "（无）",
                    "新增消息：",
                    ...messages.map((item) => `- ${item.senderName ?? item.senderId}: ${truncateMiddle(item.text, 500)}`),
                ].join("\n"),
                signal: controller.signal,
            });
        }
        finally {
            clearTimeout(timer);
        }
        let parsed;
        try {
            parsed = parseJsonLoose(raw);
        }
        catch {
            parsed = {};
        }
        const summaryText = typeof parsed?.summary === "string" ? parsed.summary : raw;
        const record = {
            chatId: key,
            summary: truncateMiddle(summaryText.trim(), maxChars),
            decisions: stringArray(parsed?.decisions),
            assumptions: stringArray(parsed?.assumptions),
            openQuestions: stringArray(parsed?.open_questions),
            lastMessageAt: Math.max(...messages.map((item) => item.at)),
            updatedAt: Date.now(),
        };
        this.groupContext.set(key, record);
        await this.groupContext.flush();
        await this.audit.append({
            actor: { system: true },
            action: "group_summary_updated",
            details: { chatId, messages: messages.length },
        });
    }
    evidenceRecall(message) {
        return this.contextService.evidenceRecall(message);
    }
    quotedContext(message) {
        return this.contextService.quotedContext(message);
    }
    analysisContext(task) {
        return this.contextService.analysisContext(task);
    }
    async verifyAnalysis(task, analysis, signal) {
        const context = await this.analysisContext(task);
        const base = deterministicVerification(analysis, context.corpus);
        if (!this.config.subagents.enabled || !this.config.subagents.reviewer)
            return base;
        const directory = await this.analysisDirectory(task);
        const title = `${this.config.opencode.sessionTitlePrefix}:worker:review:${task.chatId}`;
        try {
            const raw = await this.runWorker({
                platform: task.platform,
                chatId: task.chatId,
                directory,
                title,
                role: "review",
                permission: READ_ONLY_PERMISSION,
                agent: this.config.subagents.reviewer,
            }, [
                "你是只读核实器。不要修改文件，不要执行写操作。",
                "核对任务分析是否忠于群上下文，是否跑偏、扩大范围或把假设写成事实。",
                "表名 / 接口 / 字段 / 配置要能在上下文或仓库找到；找不到就列出。",
                '输出严格 JSON：{drift: "none"|"minor"|"major", reasons: [], unverified_identifiers: [], checked: [], assumptions: []}。',
                "上下文：",
                JSON.stringify({
                    title: task.title,
                    excerpt: task.excerpt,
                    messageIds: task.messageIds,
                    sourceMessages: context.sourceMessages,
                    recentContext: context.recentContext,
                    pinned: context.pinned,
                    memory: context.memory,
                    openTasks: context.openTasks,
                }),
                "分析：",
                JSON.stringify(analysis),
            ].join("\n"), signal);
            return mergeVerification(base, parseVerification(raw));
        }
        catch (error) {
            this.logger.warn("analysis verification failed; keeping deterministic checks", {
                taskId: task.id,
                error: toErrorMessage(error),
            });
            return base;
        }
    }
    async analysisDirectory(task) {
        const repo = this.config.repos[0];
        if (repo)
            return repo.path;
        const project = await this.resolveProject(task.chatId);
        return project.worktree;
    }
    async resolveProject(chatId) {
        const bound = this.projectStore.get(chatId);
        if (bound) {
            return {
                worktree: bound.worktree,
                projectId: bound.projectId,
                resolved: true,
                reason: `chat bound: ${bound.reason}`,
            };
        }
        const cached = this.projectCache.get(chatId);
        const cacheMs = this.config.project.cacheSeconds * 1000;
        if (cached && Date.now() - cached.at < cacheMs) {
            return cached;
        }
        if (!this.projectResolver) {
            this.projectResolver = new ProjectResolver({
                client: this.options.bridge.getClient(),
                allowlist: this.config.project.allowlist,
                ...(this.config.project.id ? { explicitProjectId: this.config.project.id } : {}),
                ...(this.config.project.worktree ? { explicitWorktree: this.config.project.worktree } : {}),
                ...(this.config.project.fallbackWorktree
                    ? { fallbackWorktree: this.config.project.fallbackWorktree }
                    : {}),
                recentSessions: this.config.project.recentSessions,
                maxAgeDays: this.config.project.maxAgeDays,
                logger: this.logger.child("project"),
            });
        }
        const selection = await this.projectResolver.resolve();
        let resolution;
        if (selection) {
            resolution = {
                worktree: selection.project.worktree,
                projectId: selection.project.id,
                resolved: true,
                reason: selection.reason,
            };
            this.logger.info("project resolved", candidateLogFields(selection));
        }
        else if (this.config.repos[0]?.path) {
            resolution = {
                worktree: this.config.repos[0].path,
                resolved: true,
                reason: "repos[0] fallback",
            };
            this.logger.warn("no active project resolved; using repos[0]", {
                worktree: resolution.worktree,
            });
        }
        else if (this.config.project.fallbackWorktree) {
            resolution = {
                worktree: this.config.project.fallbackWorktree,
                resolved: true,
                reason: "fallbackWorktree",
            };
            this.logger.warn("no active project resolved; using fallbackWorktree", {
                worktree: resolution.worktree,
            });
        }
        else {
            resolution = {
                worktree: join(this.stateDir, "scratch"),
                resolved: false,
                reason: "no project resolved; refusing to use home/cwd",
            };
            this.logger.error("no project resolved; task work will require manual configuration");
        }
        this.projectCache.set(chatId, { ...resolution, at: Date.now() });
        if (resolution.resolved && this.config.project.bindChat && selection) {
            this.projectStore.set(chatId, {
                projectId: selection.project.id,
                worktree: selection.project.worktree,
                ...(selection.project.name ? { name: selection.project.name } : {}),
                reason: selection.reason,
                boundAt: Date.now(),
            });
            await this.projectStore.flush();
            this.chatContext.bindProject(`${this.options.platform.platform}:${chatId}`, selection.project.id, selection.project.worktree);
        }
        return resolution;
    }
    askOpenCode(message, style, signal, depth = "answer") {
        return this.replyService.draft(message, style, signal, depth);
    }
    async safeReply(message, text) {
        const key = `reply:${message.platform}:${message.messageId}:${sha256(text).slice(0, 12)}`;
        if (this.outbound.has(key)) {
            this.logger.info("skip duplicate reply", { messageId: message.messageId });
            return true;
        }
        try {
            await this.sendLimiter.take();
            await this.options.platform.reply({ chatId: message.chat.id, messageId: message.messageId }, { kind: "text", text, uuid: stableUuid(key) });
            this.outbound.add(key);
            await this.outbound.flush();
            this.evidence.append({
                ts: Date.now(),
                platform: message.platform,
                chatId: message.chat.id,
                ...(message.chat.name ? { chatName: message.chat.name } : {}),
                messageId: message.messageId,
                direction: "outbound",
                origin: "reply",
                text,
            });
            return true;
        }
        catch (error) {
            this.logger.error("failed to reply", {
                messageId: message.messageId,
                error: toErrorMessage(error),
            });
            return false;
        }
    }
    async sendToApprover(text) {
        return this.sendToOwner(text);
    }
    async markProcessed(message) {
        this.dedup.add(`${message.platform}:${message.messageId}`);
        await this.dedup.flush();
    }
    sanitize(text) {
        return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
    }
    stats() {
        return this.dispatcher.snapshot();
    }
}
function requireStateDir(config) {
    const stateDir = config.app.stateDir;
    if (!stateDir)
        throw new Error("app.stateDir is required");
    return stateDir.startsWith("~") ? join(process.env.HOME ?? "", stateDir.slice(2)) : stateDir;
}
function createFilterClient(options, logger) {
    if (options.llm)
        return options.llm;
    const { config, secrets } = options.loaded;
    if (config.filter.mode === "opencode") {
        return new OpenCodeLlmClient({
            bridge: options.bridge,
            directory: config.project.worktree ?? config.repos[0]?.path ?? process.cwd(),
            titlePrefix: config.opencode.sessionTitlePrefix,
            ...(config.opencode.analysisAgent ? { agent: config.opencode.analysisAgent } : {}),
            ...(config.analysis.model ? { model: config.analysis.model } : {}),
            logger: logger.child("filter"),
        });
    }
    if (!config.filter.enabled) {
        return {
            async complete() {
                throw new Error("filter disabled");
            },
        };
    }
    return new OpenAiCompatibleClient({
        baseUrl: config.filter.baseUrl,
        apiKey: secrets.filterApiKey,
        model: config.filter.model,
        timeoutMs: config.filter.timeoutMs,
        logger: logger.child("llm"),
    });
}
function suggestedActionLabel(actionability) {
    switch (actionability) {
        case "task":
            return "转任务";
        case "question":
            return "可代答";
        case "fyi":
            return "仅知会";
        default:
            return "忽略";
    }
}
function stringArray(value) {
    return Array.isArray(value)
        ? value.filter((item) => typeof item === "string")
        : [];
}
//# sourceMappingURL=runtime.js.map