import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { createLogger } from "./logger.js";
import { OpenAiCompatibleClient, RelevanceService, parseJsonLoose, } from "./relevance.js";
import { detectReplyStyle, enforceReplyLength, } from "./reply-style.js";
import { ConcurrentDispatcher } from "./dispatcher.js";
import { PollingService } from "./poller.js";
import { TokenBucket } from "./rate-limit.js";
import { GitExecutor } from "./executor.js";
import { ProjectResolver, candidateLogFields } from "./project-resolver.js";
import { OpenCodeLlmClient } from "./opencode-llm.js";
import { selectBurstExtensions, mergeBurst } from "./burst.js";
import { SenderLimiter } from "./sender-limiter.js";
import { SessionManager } from "./session-manager.js";
import { ContextService } from "./context-service.js";
import { ApprovalService } from "./approval-service.js";
import { ExecutionService } from "./execution-service.js";
import { OwnerCommandService } from "./owner-command-service.js";
import { ReplyService } from "./reply-service.js";
import { TaskService } from "./task-service.js";
import { IntentService } from "./intent-service.js";
import { MessageIngress } from "./message-ingress.js";
import { MeMentionFlow } from "./me-mention-flow.js";
import { BotMentionFlow } from "./bot-mention-flow.js";
import { ScanService } from "./scan-service.js";
import { NotificationService } from "./notification-service.js";
import { RecoveryService } from "./recovery-service.js";
import { GroupWorkspaceManager } from "./group-workspace.js";
import { GroupStateLayout, ScopedApprovals, ScopedAudit, ScopedChatContext, ScopedDedup, ScopedCursors, ScopedEvidence, ScopedGroupContext, ScopedMemory, ScopedPending, ScopedProjects, ScopedSentReplies, ScopedSessions, ScopedTasks, } from "./group-state.js";
import { parseOwnerCommand } from "./owner-command.js";
import { OwnerStore } from "./owner-store.js";
import { OwnerAccessService } from "./owner-access-service.js";
import { readJsonFile, sha256, toErrorMessage, redactPreview, truncate, truncateMiddle, writeJsonAtomic, } from "./util.js";
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
    historyMentions;
    outbound;
    groupState;
    groupWorkspace;
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
    taskService;
    intentService;
    messageIngress;
    meMentionFlow;
    botMentionFlow;
    scanService;
    notificationService;
    recoveryService;
    sentReplies;
    ownerAccess;
    groupLocks = new Map();
    blockedDirectAlerts = new Map();
    messageControllers = new Map();
    recoveryPromise;
    missingProjectNotices = new Map();
    memory;
    senderLimiter;
    projectResolver;
    background = new Set();
    projectCache = new Map();
    constructor(options) {
        this.options = options;
        this.logger = options.logger ?? createLogger({ scope: "runtime" });
        this.config = options.loaded.config;
        this.stateDir = requireStateDir(this.config);
        this.groupState = new GroupStateLayout(join(this.stateDir, "groups"), this.logger.child("group-state"));
        this.groupWorkspace = new GroupWorkspaceManager(this.config.workspace?.root ??
            (this.stateDir.startsWith("/tmp/") ? join(this.stateDir, "atme-groups") : "/mnt/d/Work/atme-groups"), this.logger.child("group-workspace"));
        this.dedup = new ScopedDedup(this.groupState, "dedup.json", 7 * 24 * 3600 * 1000, 100_000, this.logger.child("dedup"));
        this.historyMentions = new ScopedDedup(this.groupState, "history-mentions.json", 90 * 24 * 3600 * 1000, 20_000, this.logger.child("history-mentions"));
        this.outbound = new ScopedDedup(this.groupState, "outbound.json", 7 * 24 * 3600 * 1000, 50_000, this.logger.child("outbound"));
        this.cursors = new ScopedCursors(this.groupState, this.logger.child("cursor"));
        this.sessions = new ScopedSessions(this.groupState, this.logger.child("sessions"));
        this.sessionManager = new SessionManager({
            bridge: this.options.bridge,
            sessions: this.sessions,
            config: this.config,
            logger: this.logger.child("sessions"),
            readOnlyPermission: READ_ONLY_PERMISSION,
        });
        this.tasks = new ScopedTasks(this.groupState, this.logger.child("tasks"));
        this.approvals = new ScopedApprovals(this.groupState, async (taskId) => {
            const task = await this.tasks.get(taskId);
            return task?.chatId;
        });
        this.audit = new ScopedAudit(this.groupState, async (taskId) => {
            const task = await this.tasks.get(taskId);
            return task?.chatId;
        });
        this.pending = new ScopedPending(this.groupState, this.logger.child("pending"));
        this.sentReplies = new ScopedSentReplies(this.groupState, 7 * 24 * 3600_000, 50, this.logger.child("sent-replies"));
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
            sentReplies: this.sentReplies,
            startExecution: (task, planHash) => {
                this.track(this.executionService.executeTask(task, planHash)).catch((error) => {
                    this.logger.error("execution failed", {
                        taskId: task.id,
                        error: toErrorMessage(error),
                    });
                });
            },
        });
        this.projectStore = new ScopedProjects(this.groupState, this.logger.child("projects"));
        this.senderLimiter = new SenderLimiter({
            maxPerMinute: this.config.botReply.perSenderPerMinute,
            maxConcurrent: this.config.botReply.perSenderConcurrent,
            cooldownMs: this.config.botReply.cooldownSeconds * 1000,
        });
        this.ownerAccess = new OwnerAccessService({
            config: this.config,
            loaded: this.options.loaded,
            owners: new OwnerStore(join(this.stateDir, "owner.json"), this.logger.child("owner")),
            audit: this.audit,
            logger: this.logger.child("owner"),
            sendToOwner: (text) => this.sendToOwner(text),
        });
        this.ownerAccess.init();
        this.chatContext = new ScopedChatContext(this.groupState, {
            maxMessagesPerChat: this.config.context.maxMessagesPerChat,
            maxCharsPerMessage: this.config.context.maxCharsPerMessage,
            maxChats: this.config.context.maxChats,
            ttlMs: this.config.context.ttlDays * 86_400_000,
            logger: this.logger.child("context"),
        });
        this.memory = new ScopedMemory(this.groupState, {
            maxEntries: this.config.memory.maxEntries,
            ttlMs: this.config.memory.ttlDays * 86_400_000,
            pinnedKinds: this.config.memory.pinnedKinds,
            logger: this.logger.child("memory"),
        });
        this.evidence = new ScopedEvidence(this.groupState, {
            enabled: this.config.evidence?.enabled ?? true,
            retentionDays: this.config.evidence?.retentionDays ?? 720,
            maxChars: this.config.evidence?.maxChars ?? 4000,
            logger: this.logger.child("evidence"),
        });
        this.groupContext = new ScopedGroupContext(this.groupState, this.logger.child("group-context"));
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
        this.messageIngress = new MessageIngress({
            config: this.config,
            logger: this.logger.child("ingress"),
            dedup: this.dedup,
            chatContext: this.chatContext,
            evidence: this.evidence,
            senderLimiter: this.senderLimiter,
            activeMessageIds: this.activeMessageIds,
            ownerOpenId: () => this.ownerOpenId(),
            botOpenId: () => this.options.platform.getBotOpenId?.() ??
                this.config.platforms.feishu.botOpenId,
            rememberRecent: (message) => this.rememberRecent(message),
            updateGroupSummary: (platform, chatId) => {
                void this.updateGroupSummary(platform, chatId);
            },
            acknowledge: (message) => this.acknowledge(message),
            safeReply: (message, text) => this.safeReply(message, text),
            dispatch: (message, limited, wait) => this.dispatchGroupMessage(message, limited, wait),
        });
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
            sendReplyManagementCard: () => this.approvalService.sendReplyManagementCard(),
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
            ...(this.config.opencode.replyModel ? { model: this.config.opencode.replyModel } : {}),
            readOnlyPermission: READ_ONLY_PERMISSION,
            ownerOpenId: () => this.ownerOpenId(),
            resolveProject: async (chatId) => {
                const project = await this.resolveProject(chatId);
                return {
                    worktree: project.worktree,
                    resolved: project.resolved,
                    ...(project.secondaryWorktrees
                        ? { secondaryWorktrees: project.secondaryWorktrees }
                        : {}),
                    ...(project.coreProjects ? { coreProjects: project.coreProjects } : {}),
                    ...(project.referenceProjects
                        ? { referenceProjects: project.referenceProjects }
                        : {}),
                };
            },
            refreshSummary: (platform, chatId) => this.updateGroupSummary(platform, chatId),
        });
        this.taskService = new TaskService({
            config: this.config,
            stateDir: this.stateDir,
            stateDirFor: (chatId) => this.groupState.dirFor(chatId),
            workspaceDirFor: (chatId) => this.groupWorkspace.dirFor(chatId),
            tasks: this.tasks,
            audit: this.audit,
            contextService: this.contextService,
            sessionManager: this.sessionManager,
            logger: this.logger.child("task"),
            readOnlyPermission: READ_ONLY_PERMISSION,
            resolveProject: async (chatId) => {
                const project = await this.resolveProject(chatId);
                return {
                    worktree: project.worktree,
                    resolved: project.resolved,
                    ...(project.secondaryWorktrees
                        ? { secondaryWorktrees: project.secondaryWorktrees }
                        : {}),
                    ...(project.coreProjects ? { coreProjects: project.coreProjects } : {}),
                    ...(project.referenceProjects
                        ? { referenceProjects: project.referenceProjects }
                        : {}),
                };
            },
            memory: this.memory,
            projectId: (chatId) => this.projectStore.get(chatId)?.projectId,
            startAnalysis: (task) => {
                this.track(this.taskService.analyzeTask(task)).catch((error) => {
                    this.logger.error("task analysis failed", {
                        taskId: task.id,
                        error: toErrorMessage(error),
                    });
                });
            },
            sendToApprover: (text) => this.sendToApprover(text),
            sendApproval: (task, analysis) => this.sendApproval(task, analysis),
        });
        this.executor = new GitExecutor({
            worktreeRoot: join(this.stateDir, "worktrees"),
            timeoutMs: this.config.policy.executionTimeoutMinutes * 60_000,
            logger: this.logger.child("executor"),
        });
        this.executionService = new ExecutionService({
            config: this.config,
            stateDir: this.stateDir,
            stateDirFor: (chatId) => this.groupState.dirFor(chatId),
            workspaceDirFor: (chatId) => this.groupWorkspace.dirFor(chatId),
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
        this.notificationService = new NotificationService({
            config: this.config,
            logger: this.logger.child("notify"),
            platform: this.options.platform,
            bridge: this.options.bridge,
            sendLimiter: this.sendLimiter,
            evidence: this.evidence,
            outbound: this.outbound,
            sentReplies: this.sentReplies,
            chatNames: this.chatNames,
            ownerOpenId: () => this.ownerOpenId(),
        });
        this.recoveryService = new RecoveryService({
            config: this.config,
            logger: this.logger.child("recovery"),
            platform: this.options.platform,
            pending: this.pending,
            tasks: this.tasks,
            dedup: this.dedup,
            historyMentions: this.historyMentions,
            sentReplies: this.sentReplies,
            groupIds: this.groupIds,
            lastCursor: (_platform, chatId) => this.cursors.get(chatId),
            recordCursor: async (chatId, endTime) => {
                this.cursors.set(chatId, endTime);
                await this.cursors.flush();
            },
            isMention: (message) => this.isMention(message),
            ingest: (message, force) => this.ingest(message, force),
            ingestBatch: (messages) => this.ingestBatch(messages),
            analyzeTask: (task) => this.analyzeTask(task),
            track: (promise) => this.track(promise),
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
            projectContext: (chatId) => {
                const project = this.config.platforms.feishu.groups.find((group) => group.chatId === chatId)?.project;
                return project
                    ? {
                        core: [project.primary, ...(project.core ?? [])].filter((value) => Boolean(value)),
                        reference: [...(project.reference ?? []), ...(project.secondary ?? [])],
                    }
                    : { core: [], reference: [] };
            },
            logger: this.logger.child("relevance"),
        });
        this.intentService = new IntentService({
            config: this.config,
            relevance: () => this.relevance,
            llm,
            filterEnabled: this.filterEnabled,
            chatContext: this.chatContext,
            replyOptions: this.replyOptions,
            logger: this.logger.child("intent"),
        });
        this.meMentionFlow = new MeMentionFlow({
            config: this.config,
            logger: this.logger.child("me-mention"),
            intentService: this.intentService,
            replyService: this.replyService,
            taskService: this.taskService,
            tasks: this.tasks,
            audit: this.audit,
            prepare: async (message, signal) => {
                await this.waitForBurst(message, signal);
                const burst = await this.applyBurstGrouping(message);
                return { enriched: mergeBurst(message, burst), burst };
            },
            markProcessed: (message) => this.markProcessed(message),
            safeReply: (message, text) => this.safeReply(message, text),
            sendToApprover: (text) => this.sendToApprover(text),
        });
        this.botMentionFlow = new BotMentionFlow({
            config: this.config,
            logger: this.logger.child("bot-mention"),
            intentService: this.intentService,
            replyService: this.replyService,
            sessionManager: this.sessionManager,
            bridge: this.options.bridge,
            platform: this.options.platform,
            sendLimiter: this.sendLimiter,
            audit: this.audit,
            readOnlyPermission: READ_ONLY_PERMISSION,
            ownerOpenId: () => this.ownerOpenId(),
            ownerName: () => this.ownerName(),
            resolveProject: (chatId) => this.resolveProject(chatId),
            sendToOwner: (text, sourceMessageId) => this.sendToOwner(text, sourceMessageId),
            sendToApprover: (text) => this.sendToApprover(text),
            safeReply: (message, text) => this.safeReply(message, text),
            markProcessed: (message) => this.markProcessed(message),
            rememberFromMention: (message, intent, analysis) => this.rememberFromMention(message, intent, analysis),
        });
        this.scanService = new ScanService({
            config: this.config,
            logger: this.logger.child("scan"),
            relevance: () => this.relevance,
            platform: this.options.platform,
            ownerOpenId: () => this.ownerOpenId(),
            dispatcher: this.dispatcher,
            chatContext: this.chatContext,
            intentService: this.intentService,
            taskService: this.taskService,
            filterEnabled: this.filterEnabled,
            groupIds: this.groupIds,
            dedup: this.dedup,
            activeMessageIds: this.activeMessageIds,
            isMention: (message) => this.isMention(message),
            onMessage: (message, wait) => this.onMessage(message, wait),
            markProcessed: (message) => this.markProcessed(message),
            sendToApprover: (text) => this.sendToApprover(text),
            sendToOwner: (text) => this.sendToOwner(text),
        });
    }
    async ensureGroupWorkspace(chatId, name, project) {
        const info = await this.groupState.ensure(chatId, name);
        await this.groupWorkspace.ensure({
            chatId,
            name: info.name,
            stateGroupDir: info.dir,
            ...(project
                ? {
                    project: {
                        primary: project.primary ?? null,
                        core: project.core ?? [],
                        reference: project.reference ?? [],
                        secondary: project.secondary ?? [],
                    },
                }
                : {}),
        });
    }
    ownerOpenId() {
        return this.ownerAccess.openId();
    }
    ownerName() {
        return this.ownerAccess.name();
    }
    claimOwner(message) {
        return this.ownerAccess.claim(message);
    }
    sendToOwner(text, sourceMessageId) {
        return this.notificationService.sendToOwner(text, sourceMessageId);
    }
    async acknowledge(message) {
        const emoji = this.config.reply.ackReaction ?? "OK";
        if (!emoji)
            return;
        const acknowledge = this.options.platform.acknowledge;
        if (!acknowledge)
            return;
        try {
            await acknowledge.call(this.options.platform, message.messageId, emoji);
        }
        catch (error) {
            this.logger.warn("failed to add acknowledgement reaction", {
                messageId: message.messageId,
                error: toErrorMessage(error),
            });
        }
    }
    linkAbort(controller, signal) {
        const onAbort = () => controller.abort(signal.reason);
        if (signal.aborted) {
            controller.abort(signal.reason);
            return () => { };
        }
        signal.addEventListener("abort", onAbort, { once: true });
        return () => signal.removeEventListener("abort", onAbort);
    }
    async onMessageRecalled(event) {
        const key = `${event.platform}:${event.messageId}`;
        const controller = this.messageControllers.get(key);
        if (controller) {
            controller.abort(new Error("message recalled"));
            this.messageControllers.delete(key);
        }
        this.activeMessageIds.delete(key);
        this.dedup.add(key, event.chatId);
        await this.dedup.flush();
        const replies = this.sentReplies.listBySource(event.messageId);
        for (const reply of replies) {
            try {
                if (!this.options.platform.recallMessage) {
                    this.logger.warn("platform cannot recall bot replies", { messageId: event.messageId });
                    break;
                }
                await this.options.platform.recallMessage(reply.chatId, reply.sentMessageId);
                await this.sentReplies.markRecalled(reply.id);
                this.logger.info("recalled bot reply after source message recall", {
                    sourceMessageId: event.messageId,
                    sentMessageId: reply.sentMessageId,
                    chatId: reply.chatId,
                });
            }
            catch (error) {
                this.logger.warn("failed to recall bot reply after source recall", {
                    sourceMessageId: event.messageId,
                    sentMessageId: reply.sentMessageId,
                    error: toErrorMessage(error),
                });
            }
        }
        this.logger.info("message recalled; processing aborted", {
            messageId: event.messageId,
            chatId: event.chatId,
            aborted: Boolean(controller),
            repliesRecalled: replies.length,
        });
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
        await mkdir(join(this.stateDir, "scratch"), { recursive: true });
        await this.groupState.load();
        for (const group of this.config.platforms.feishu.groups) {
            await this.ensureGroupWorkspace(group.chatId, group.name, group.project);
        }
        await this.dedup.load();
        await this.historyMentions.load();
        await this.outbound.load();
        await this.sentReplies.load();
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
        await this.ownerAccess.load();
        this.ownerAccess.reconcile();
        await this.options.platform.start({
            onMessage: (message) => this.onMessage(message),
            onAction: (action) => this.onAction(action),
            onChatMembership: (event) => this.onChatMembership(event),
            onChatUpdated: (event) => this.onChatUpdated(event),
            onMessageRecalled: (event) => this.onMessageRecalled(event),
            onReconnected: () => this.onReconnected(),
        });
        await this.syncGroups();
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
            this.historyMentions.close(),
            this.outbound.close(),
            this.sentReplies.flush(),
            this.cursors.flush(),
            this.sessions.flush(),
            this.tasks.close(),
            this.pending.flush(),
            this.projectStore.flush(),
            this.chatContext.flush(),
            this.memory.flush(),
            this.groupContext.flush(),
            this.ownerAccess.flush(),
        ]);
        this.logger.info("runtime stopped");
    }
    async onMessage(message, wait = false, force = false) {
        if (message.senderType !== "user")
            return;
        const chatName = await this.chatLabel(message);
        await this.ensureGroupWorkspace(message.chat.id, message.chat.kind === "direct" ? "私聊" : chatName, this.config.platforms.feishu.groups.find((group) => group.chatId === message.chat.id)?.project);
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
        const wasSeen = this.dedup.has(dedupKey, message.chat.id);
        await this.messageIngress.handle(message, chatName, wait, force);
        if (!wasSeen && this.isMention(message)) {
            this.historyMentions.add(dedupKey, message.chat.id);
        }
    }
    async dispatchGroupMessage(message, limited, wait, force = false) {
        const dedupKey = `${message.platform}:${message.messageId}`;
        this.logger.info("dispatch group message", {
            messageId: message.messageId,
            mention: this.isMention(message),
            wait,
            force,
            limited,
        });
        const mention = this.isMention(message);
        const controller = new AbortController();
        this.messageControllers.set(dedupKey, controller);
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
                const unlink = this.linkAbort(controller, signal);
                try {
                    this.logger.info("dispatch job started", { messageId: message.messageId, force });
                    if (controller.signal.aborted || (!force && this.dedup.has(dedupKey, message.chat.id)))
                        return;
                    await this.handleMessage(message, controller.signal);
                    this.logger.info("dispatch job finished", { messageId: message.messageId });
                }
                finally {
                    unlink();
                    this.messageControllers.delete(dedupKey);
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
    async ingest(message, force = false) {
        await this.onMessage(message, true, force);
    }
    async ingestBatch(messages) {
        await this.handlePolledBatch(messages);
    }
    isMention(message) {
        return this.isMentionMe(message) || this.isMentionBot(message);
    }
    isMentionMe(message) {
        const me = this.ownerOpenId();
        const ownerName = this.config.platforms.feishu.me.name;
        return ((Boolean(me) && message.mentions.some((mention) => mention.id === me)) ||
            Boolean(ownerName && message.text.includes(`@${ownerName}`)));
    }
    isMentionBot(message) {
        const platform = this.options.platform;
        const bot = platform.getBotOpenId?.() ?? this.config.platforms.feishu.botOpenId;
        const botName = platform.getBotName?.();
        return ((Boolean(bot) && message.mentions.some((mention) => mention.id === bot)) ||
            Boolean(botName && message.text.includes(`@${botName}`)));
    }
    async syncGroups() {
        const feishu = this.config.platforms.feishu;
        if (feishu.autoSyncGroups === false || !this.options.platform.listGroups)
            return;
        try {
            const groups = await this.options.platform.listGroups();
            const added = groups.filter((group) => !this.groupIds.has(group.chatId));
            for (const group of groups) {
                this.groupIds.add(group.chatId);
                await this.ensureGroupWorkspace(group.chatId, group.name, this.config.platforms.feishu.groups.find((item) => item.chatId === group.chatId)?.project);
                if (group.name)
                    this.notificationService.rememberChatName(group.chatId, group.name);
            }
            if (added.length > 0) {
                await this.persistGroups(added);
                this.logger.info("startup group sync added groups", {
                    added: added.map((group) => group.chatId),
                });
            }
        }
        catch (error) {
            this.logger.warn("startup group sync failed; using configured allowlist", {
                error: toErrorMessage(error),
            });
        }
    }
    async persistGroups(groups) {
        const path = this.options.loaded.path;
        if (!path)
            return;
        try {
            const raw = await readJsonFile(path, {});
            const feishu = (raw.platforms ??= {}).feishu ??= {};
            const existing = Array.isArray(feishu.groups) ? feishu.groups : [];
            const byId = new Map(existing
                .filter((item) => item && typeof item.chatId === "string")
                .map((item) => [item.chatId, item]));
            for (const group of groups) {
                if (!byId.has(group.chatId)) {
                    byId.set(group.chatId, {
                        chatId: group.chatId,
                        ...(group.name ? { name: group.name } : {}),
                        enabled: true,
                        project: { secondary: [] },
                    });
                }
            }
            feishu.groups = [...byId.values()];
            this.config.platforms.feishu.groups = feishu.groups;
            await writeJsonAtomic(path, raw);
            this.logger.info("startup group sync persisted groups", {
                path,
                added: groups.map((group) => group.chatId),
            });
        }
        catch (error) {
            this.logger.warn("startup group sync could not persist config", {
                path,
                error: toErrorMessage(error),
            });
        }
    }
    async onChatUpdated(event) {
        if (!event.name)
            return;
        const project = this.config.platforms.feishu.groups.find((group) => group.chatId === event.chatId)?.project;
        await this.ensureGroupWorkspace(event.chatId, event.name, project);
        this.notificationService.rememberChatName(event.chatId, event.name);
        await this.audit.append({
            actor: { system: true },
            action: "chat_name_updated",
            details: { chatId: event.chatId, chatName: event.name },
        });
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
        this.notificationService.rememberChatName(event.chatId, name);
        this.groupIds.add(event.chatId);
        await this.persistGroups([{ chatId: event.chatId, name }]);
        this.logger.info("bot added to chat", {
            chatId: event.chatId,
            chatName: name,
            actorId: event.actorId,
            allowlisted: true,
        });
        await this.sendToOwner(`机器人已被加入群：${name}\nchat_id：${event.chatId}\n已自动加入处理白名单；后续启动会自动同步群列表。`);
        await this.audit.append({
            actor: { system: true },
            action: "bot_added_to_chat",
            details: { chatId: event.chatId, chatName: name, actorId: event.actorId },
        });
    }
    fetchChatName(chatId) {
        return this.notificationService.fetchChatName(chatId);
    }
    chatLabel(message) {
        return this.notificationService.chatLabel(message);
    }
    handleOwnerCommand(message, command) {
        return this.ownerCommandService.handle(message, command);
    }
    async notifyBlockedDirect(message) {
        const now = Date.now();
        const last = this.blockedDirectAlerts.get(message.sender.id) ?? 0;
        if (now - last < 10 * 60_000)
            return;
        this.blockedDirectAlerts.set(message.sender.id, now);
        if (this.blockedDirectAlerts.size > 500)
            this.blockedDirectAlerts.clear();
        const preview = message.text.trim()
            ? redactPreview(message.text)
            : "[非文本消息]";
        const sent = await this.sendToOwner([
            "有人试图私聊机器人，已被拦截。",
            `发送人：${message.sender.displayName ?? message.sender.id}`,
            `ID：${message.sender.id}`,
            `内容：${truncate(preview, 160)}`,
        ].join("\n"));
        if (sent)
            await this.markProcessed(message);
    }
    async handleDirectMessage(message) {
        if (!this.config.directChat.enabled)
            return;
        const ownerId = this.ownerOpenId();
        if (this.config.directChat.onlyOwner && (!ownerId || message.sender.id !== ownerId)) {
            this.logger.info("ignoring direct message from non-owner", {
                senderId: message.sender.id,
            });
            if (ownerId && this.config.directChat.notifyBlocked !== false) {
                await this.notifyBlockedDirect(message);
            }
            return;
        }
        const dedupKey = `${message.platform}:${message.messageId}`;
        if (this.dedup.has(dedupKey, message.chat.id) || this.activeMessageIds.has(dedupKey))
            return;
        this.activeMessageIds.add(dedupKey);
        void this.acknowledge(message);
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
                const controller = new AbortController();
                this.messageControllers.set(dedupKey, controller);
                const unlink = this.linkAbort(controller, signal);
                try {
                    if (controller.signal.aborted || this.dedup.has(dedupKey, message.chat.id))
                        return;
                    const style = detectReplyStyle(message, this.replyOptions);
                    const reply = await this.askOpenCode(message, style, controller.signal);
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
                    unlink();
                    this.messageControllers.delete(dedupKey);
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
    async waitForBurst(_message, signal) {
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
    async applyBurstGrouping(message) {
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
    handleBotMention(message, signal) {
        return this.botMentionFlow.handle(message, signal);
    }
    handleMeMention(message, signal) {
        return this.meMentionFlow.handle(message, signal);
    }
    handlePolledBatch(messages) {
        return this.scanService.handlePolledBatch(messages);
    }
    handleGroupScan(message, signal) {
        return this.scanService.handleGroupScan(message, signal);
    }
    analyzeTask(task) {
        return this.taskService.analyzeTask(task);
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
            summary: `【${task.chatName ?? task.chatId}】${truncate(task.excerpt, 200)}`,
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
        if (!this.started)
            return;
        if (this.recoveryPromise)
            return this.recoveryPromise;
        this.recoveryPromise = (async () => {
            await this.syncGroups();
            await this.recoveryService.recoverOnStartup();
        })().finally(() => {
            this.recoveryPromise = undefined;
        });
        return this.recoveryPromise;
    }
    async notifyMissingProject(chatId) {
        const group = this.config.platforms.feishu.groups.find((item) => item.chatId === chatId);
        if (!group?.project || group.project.primary?.trim())
            return;
        const now = Date.now();
        const last = this.missingProjectNotices.get(chatId) ?? 0;
        if (now - last < 24 * 3600_000)
            return;
        this.missingProjectNotices.set(chatId, now);
        const paths = [
            this.config.project.worktree,
            ...this.config.repos.map((repo) => repo.path),
            ...(group.project.secondary ?? []),
        ].filter((value) => Boolean(value));
        const parents = [...new Set(paths.map((value) => dirname(value)))];
        const suggestion = parents.length > 0
            ? `参考现有项目位置：\n${parents.slice(0, 3).map((item) => `- ${item}`).join("\n")}\n建议在相同目录下创建项目目录。`
            : "请提供主项目目录，以及可选的参考项目目录。";
        await this.sendToOwner([
            `群「${group.name ?? chatId}」还没有配置主项目目录。`,
            suggestion,
            "请私聊我主项目路径；如果有次项目/参考项目，也一起给我。",
        ].join("\n"));
    }
    async onReconnected() {
        if (!this.started)
            return;
        this.logger.info("network restored; syncing groups and recovering missed messages");
        await this.syncGroups();
        await this.recoverOnStartup();
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
            return false;
        const chatId = pending.chatId;
        const sourceMessageId = pending.sourceMessageId;
        if (!chatId || !sourceMessageId) {
            await this.sendToApprover("代答失败：缺少原消息信息");
            return false;
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
            const sent = await this.safeReply(original, `${ASSISTANT_LABEL} ${this.sanitize(reply)}`);
            if (!sent) {
                await this.sendToApprover(`代答发送失败，草稿已保留：${task.title}`);
                return false;
            }
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
            return true;
        }
        catch (error) {
            this.logger.error("approved reply failed", {
                taskId: task.id,
                error: toErrorMessage(error),
            });
            await this.sendToApprover(`代答失败：${task.title}\n${toErrorMessage(error)}`);
            return false;
        }
    }
    async latestAnalysis(taskId) {
        const task = await this.tasks.get(taskId);
        const dir = join(task ? this.groupState.dirFor(task.chatId) : this.stateDir, "analyses", taskId);
        const index = await readJsonFile(join(dir, "index.json"), undefined);
        const version = index?.version ?? 1;
        return readJsonFile(join(dir, `${version}.json`), undefined);
    }
    createChildSession(input) {
        return this.sessionManager.createChildSession(input);
    }
    sweepSessions() {
        return this.sessionManager.sweepSessions();
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
    createGroupSession(platform, chatId, directory) {
        return this.sessionManager.createGroupSession(platform, chatId, directory);
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
    async resolveProject(chatId) {
        const groupProject = this.config.platforms.feishu.groups.find((group) => group.chatId === chatId)?.project;
        if (groupProject) {
            const primary = groupProject.primary?.trim();
            if (!primary) {
                void this.notifyMissingProject(chatId);
                return {
                    worktree: this.config.project.worktree ?? join(this.stateDir, "scratch"),
                    secondaryWorktrees: [...(groupProject.reference ?? []), ...(groupProject.secondary ?? [])],
                    coreProjects: groupProject.core ?? [],
                    referenceProjects: [...(groupProject.reference ?? []), ...(groupProject.secondary ?? [])],
                    resolved: false,
                    reason: "group project not configured",
                };
            }
            return {
                worktree: primary,
                secondaryWorktrees: [...(groupProject.reference ?? []), ...(groupProject.secondary ?? [])],
                coreProjects: groupProject.core ?? [],
                referenceProjects: [...(groupProject.reference ?? []), ...(groupProject.secondary ?? [])],
                resolved: true,
                reason: "group project config",
            };
        }
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
                worktree: this.config.project.worktree ?? join(this.stateDir, "scratch"),
                resolved: false,
                reason: this.config.project.worktree
                    ? "no group project; using global project for analysis"
                    : "no project resolved; refusing to use home/cwd",
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
    safeReply(message, text) {
        return this.notificationService.safeReply(message, text);
    }
    sendToApprover(text) {
        return this.notificationService.sendToApprover(text);
    }
    async markProcessed(message) {
        this.dedup.add(`${message.platform}:${message.messageId}`, message.chat.id);
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
function stringArray(value) {
    return Array.isArray(value)
        ? value.filter((item) => typeof item === "string")
        : [];
}
//# sourceMappingURL=runtime.js.map