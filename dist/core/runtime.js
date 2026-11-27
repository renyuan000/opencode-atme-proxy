import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { mkdir, readdir, stat } from "node:fs/promises";
import { createLogger } from "./logger.js";
import { OpenAiCompatibleClient, RelevanceService, parseJsonLoose, } from "./relevance.js";
import { detectReplyStyle, enforceReplyLength, } from "./reply-style.js";
import { ConcurrentDispatcher } from "./dispatcher.js";
import { PollingService } from "./poller.js";
import { TokenBucket } from "./rate-limit.js";
import { GitExecutor } from "./executor.js";
import { ProjectResolver, candidateLogFields } from "./project-resolver.js";
import { prefilterMessage } from "./prefilter.js";
import { dangerousBashRules, protectedProjectRules, protectedSourceRules } from "./safety.js";
import { OpenCodeLlmClient } from "./opencode-llm.js";
import { selectBurstExtensions, mergeBurst } from "./burst.js";
import { SenderLimiter } from "./sender-limiter.js";
import { SessionManager } from "./session-manager.js";
import { ContextService } from "./context-service.js";
import { ApprovalService } from "./approval-service.js";
import { ExecutionService } from "./execution-service.js";
import { OwnerCommandService } from "./owner-command-service.js";
import { TaskAdminService } from "./task-admin.js";
import { parsePermissionReply, PermissionBridge } from "./permission-bridge.js";
import { ScopedTaskLinks } from "./task-links.js";
import { ScopedTaskEvents } from "./task-events.js";
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
import { conversationKey, conversationRefForChat } from "./conversation.js";
import { ScopedDmContext } from "./dm-context.js";
import { GroupStateLayout, ScopedApprovals, ScopedAudit, ScopedChatContext, ScopedDedup, ScopedCursors, ScopedEvidence, ScopedGroupContext, ScopedMemory, ScopedPending, ScopedProjects, ScopedSentReplies, ScopedSessions, ScopedTasks, } from "./group-state.js";
import { parseOwnerCommand } from "./owner-command.js";
import { OwnerStore } from "./owner-store.js";
import { OwnerTargetStore } from "./owner-target.js";
import { ScopedDocumentCache } from "./document-cache.js";
import { ScopedDocumentRefs } from "./document-ref-store.js";
import { JobStore } from "./job-store.js";
import { ScopedGroupKnowledge } from "./group-knowledge.js";
import { OwnerAccessService } from "./owner-access-service.js";
import { formatLocalTime, readJsonFile, sha256, toErrorMessage, redactPreview, truncate, truncateMiddle, writeJsonAtomic, } from "./util.js";
const ASSISTANT_LABEL = "（助手代答）";
const READ_ONLY_PERMISSION = [
    { permission: "edit", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "*", action: "deny" },
    { permission: "webfetch", pattern: "*", action: "deny" },
    { permission: "websearch", pattern: "*", action: "deny" },
    { permission: "external_directory", pattern: "*", action: "deny" },
];
const WEB_SEARCH_PERMISSION = [
    { permission: "edit", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "*", action: "deny" },
    { permission: "webfetch", pattern: "*", action: "deny" },
    { permission: "websearch", pattern: "*", action: "allow" },
    { permission: "external_directory", pattern: "*", action: "deny" },
];
const WEB_FETCH_PERMISSION = [
    { permission: "edit", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "*", action: "deny" },
    { permission: "webfetch", pattern: "*", action: "allow" },
    { permission: "websearch", pattern: "*", action: "allow" },
    { permission: "external_directory", pattern: "*", action: "deny" },
];
const EXECUTION_PERMISSION = [
    { permission: "webfetch", pattern: "*", action: "deny" },
    { permission: "websearch", pattern: "*", action: "deny" },
    { permission: "external_directory", pattern: "*", action: "deny" },
    ...dangerousBashRules(),
    ...protectedSourceRules(),
];
const OWNER_DM_PERMISSION = [
    { permission: "edit", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "webfetch", pattern: "*", action: "allow" },
    { permission: "websearch", pattern: "*", action: "allow" },
    { permission: "external_directory", pattern: "*", action: "ask" },
    ...dangerousBashRules(),
    ...protectedSourceRules(),
];
function configuredProjectPaths(config) {
    const paths = new Set();
    for (const group of config.platforms.feishu.groups) {
        const project = group.project;
        if (project) {
            for (const path of [
                ...(project.primary ?? []),
                ...(project.core ?? []),
                ...(project.reference ?? []),
                ...(project.secondary ?? []),
            ]) {
                if (path)
                    paths.add(path);
            }
        }
        const workspaceRoot = group.workspace?.root;
        for (const project of group.workspace?.projects ?? []) {
            if (!project.path)
                continue;
            if (isAbsolute(project.path)) {
                paths.add(project.path);
            }
            else if (workspaceRoot) {
                paths.add(resolve(workspaceRoot, project.path));
            }
        }
    }
    for (const repo of config.repos)
        paths.add(repo.path);
    return [...paths];
}
function isGenericOwnerKeyword(keyword, group) {
    const value = keyword.trim().toLowerCase();
    if (!value)
        return true;
    const names = [group.name ?? "", group.workspace?.root ?? ""]
        .join(" ")
        .replace(/^产品[-—]/i, "")
        .toLowerCase();
    if (names.includes(value))
        return true;
    return /^(流分|产品|群|任务|项目|系统|平台|台账|前端|service|adapter)$/.test(value);
}
function withProjectReadPaths(base, paths) {
    const unique = [...new Set(paths.filter(Boolean))];
    return [
        ...base,
        ...unique.flatMap((path) => [
            { permission: "external_directory", pattern: path, action: "allow" },
            { permission: "external_directory", pattern: `${path}/**`, action: "allow" },
        ]),
    ];
}
function executionPermissionFor(base, input) {
    const writable = new Set((input.writableProjects ?? []).map((path) => path.toLowerCase()));
    const readonly = [...new Set(input.referenceProjects ?? [])].filter((path) => !writable.has(path.toLowerCase()));
    if (readonly.length === 0)
        return base;
    return [
        ...base,
        ...readonly.flatMap((path) => [
            { permission: "edit", pattern: path, action: "deny" },
            { permission: "edit", pattern: `${path}/**`, action: "deny" },
            { permission: "bash", pattern: `*${path}*`, action: "deny" },
        ]),
    ];
}
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
    taskLinks;
    taskEvents;
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
    readOnlyPermission;
    ownerDmPermission;
    webSearchPermission;
    webFetchPermission;
    executionPermission;
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
    permissionBridge;
    taskAdmin;
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
    ownerTargets;
    documentCache;
    documentRefs;
    groupKnowledge;
    dmContext;
    jobsByGroup = new Map();
    groupLocks = new Map();
    groupSummaryFailureUntil = new Map();
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
        const projectPaths = configuredProjectPaths(this.config);
        this.readOnlyPermission = withProjectReadPaths(READ_ONLY_PERMISSION, projectPaths);
        this.ownerDmPermission = [...OWNER_DM_PERMISSION, ...protectedProjectRules(projectPaths)];
        this.webSearchPermission = withProjectReadPaths(WEB_SEARCH_PERMISSION, projectPaths);
        this.webFetchPermission = withProjectReadPaths(WEB_FETCH_PERMISSION, projectPaths);
        this.executionPermission = [
            ...withProjectReadPaths(EXECUTION_PERMISSION, projectPaths),
            ...protectedProjectRules(projectPaths),
        ];
        const permissionFingerprint = createHash("sha256")
            .update(JSON.stringify({
            readOnly: this.readOnlyPermission,
            ownerDm: this.ownerDmPermission,
            execution: this.executionPermission,
        }))
            .digest("hex")
            .slice(0, 10);
        this.stateDir = requireStateDir(this.config);
        this.groupState = new GroupStateLayout(join(this.stateDir, "groups"), this.logger.child("group-state"));
        this.groupWorkspace = new GroupWorkspaceManager(this.config.workspace?.root ??
            (this.stateDir.startsWith("/tmp/") ? join(this.stateDir, "atme-groups") : "/mnt/d/Work/atme-groups"), this.logger.child("group-workspace"));
        this.dedup = new ScopedDedup(this.groupState, "dedup.json", 7 * 24 * 3600 * 1000, 100_000, this.logger.child("dedup"));
        this.historyMentions = new ScopedDedup(this.groupState, "history-mentions.json", 90 * 24 * 3600 * 1000, 20_000, this.logger.child("history-mentions"));
        this.outbound = new ScopedDedup(this.groupState, "outbound.json", 7 * 24 * 3600 * 1000, 50_000, this.logger.child("outbound"));
        this.cursors = new ScopedCursors(this.groupState, this.logger.child("cursor"));
        this.sessions = new ScopedSessions(this.groupState, this.logger.child("sessions"));
        this.taskLinks = new ScopedTaskLinks(this.groupState, this.logger.child("task-links"));
        this.taskEvents = new ScopedTaskEvents(this.groupState, this.logger.child("task-events"), (chatId) => this.taskLinks.database(chatId));
        this.dmContext = new ScopedDmContext(this.groupState, this.logger.child("dm-context"));
        this.sessionManager = new SessionManager({
            bridge: this.options.bridge,
            sessions: this.sessions,
            config: this.config,
            logger: this.logger.child("sessions"),
            readOnlyPermission: this.readOnlyPermission,
            permissionFingerprint,
            linkTaskSession: ({ chatId, taskId, role, sessionId }) => this.taskLinks.linkSession(chatId, sessionId, taskId, role),
            epochFor: (chatId) => this.dmContext.get(chatId)?.sessionEpoch ??
                this.groupKnowledge.get(chatId)?.sessionEpoch ??
                1,
        });
        this.tasks = new ScopedTasks(this.groupState, this.logger.child("tasks"), (chatId) => this.taskLinks.database(chatId));
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
        this.documentCache = new ScopedDocumentCache(this.groupState, this.logger.child("document-cache"));
        this.documentRefs = new ScopedDocumentRefs(this.groupState, this.logger.child("document-refs"));
        this.groupKnowledge = new ScopedGroupKnowledge(this.groupState, this.logger.child("group-knowledge"));
        this.ownerTargets = new OwnerTargetStore(join(this.stateDir, "owner-target.json"), this.logger.child("owner-target"));
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
            supplement: (message) => this.handleTaskSupplement(message),
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
            setGroupResponsibility: (arg) => this.setGroupResponsibility(arg),
            manageWorkspace: (arg) => this.manageWorkspace(arg),
            diagnoseProject: (arg) => this.diagnoseProject(arg),
            listTasks: (arg) => this.listTasks(arg),
            reanalyzeTasks: (arg) => this.reanalyzeTasks(arg),
            archiveTasks: (arg) => this.archiveTasks(arg),
            purgeTasks: (arg) => this.purgeTasks(arg),
            cancelTasks: (arg) => this.cancelTasks(arg),
            restoreTask: (arg) => this.restoreTask(arg),
            taskSessions: (arg) => this.taskSessions(arg),
            allowPermission: (arg) => this.permissionBridge.reply(arg, "once"),
            denyPermission: (arg) => this.permissionBridge.reply(arg, "reject"),
            setOwnerFocus: (arg, kind) => this.setOwnerFocus(arg, kind),
            analyzeTask: (arg) => this.analyzePendingTask(arg),
            queryGroupMessages: (arg) => this.queryGroupMessages(arg),
            analyzeGroupMessages: (arg) => this.analyzeGroupMessages(arg),
            queryMentions: (arg) => this.queryMentions(arg),
            listOwnerTargets: () => this.listOwnerTargets(),
            selectOwnerTarget: (arg) => this.selectOwnerTarget(arg),
            getGroupKnowledge: (arg) => this.getGroupKnowledge(arg),
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
        this.taskAdmin = new TaskAdminService({
            llm,
            groups: this.config.platforms.feishu.groups
                .filter((group) => group.enabled)
                .map((group) => group.name ?? group.chatId),
            logger: this.logger.child("task-admin"),
        });
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
            readOnlyPermission: this.readOnlyPermission,
            ownerDmPermission: this.ownerDmPermission,
            webSearchPermission: this.webSearchPermission,
            webFetchPermission: this.webFetchPermission,
            ownerOpenId: () => this.ownerOpenId(),
            chatLabelFor: async (chatId) => {
                const configured = this.config.platforms.feishu.groups.find((group) => group.chatId === chatId);
                return configured?.name ?? (await this.notificationService.fetchChatName(chatId));
            },
            senderLabelFor: (userId, messageId) => this.resolveSenderLabel(userId, messageId),
            conversationIdFor: (message) => this.conversationIdFor(message.platform, message.chat.id, message.chat.kind === "direct" ? "dm" : "group"),
            dmContextFor: (chatId) => {
                const context = this.dmContext.get(chatId);
                return context
                    ? {
                        summary: context.summary,
                        preferences: context.preferences,
                        decisions: context.decisions,
                        ongoingGoals: context.ongoingGoals,
                        openQuestions: context.openQuestions,
                        sessionEpoch: context.sessionEpoch,
                    }
                    : undefined;
            },
            resolveProject: async (chatId) => {
                const project = await this.resolveProject(chatId);
                return {
                    worktree: project.worktree,
                    resolved: project.resolved,
                    ...(project.secondaryWorktrees
                        ? { secondaryWorktrees: project.secondaryWorktrees }
                        : {}),
                    ...(project.coreProjects ? { coreProjects: project.coreProjects } : {}),
                    ...(project.writableProjects ? { writableProjects: project.writableProjects } : {}),
                    ...(project.referenceProjects
                        ? { referenceProjects: project.referenceProjects }
                        : {}),
                    ...(project.workspace ? { workspace: true } : {}),
                    ...(project.workspaceRoot ? { workspaceRoot: project.workspaceRoot } : {}),
                    ...(project.workspaceProjects
                        ? { workspaceProjects: project.workspaceProjects }
                        : {}),
                    ...(project.workspaceDocs ? { workspaceDocs: project.workspaceDocs } : {}),
                };
            },
            refreshSummary: (platform, chatId) => this.updateGroupSummary(platform, chatId),
            ownerOverview: (message) => this.contextService.ownerOverview(message),
            documentCache: this.documentCache,
            documentRefs: this.documentRefs,
            documentRelevance: (chatId, doc) => {
                const responsibility = this.config.platforms.feishu.groups.find((group) => group.chatId === chatId)?.responsibility;
                if (!responsibility)
                    return undefined;
                const terms = [
                    responsibility.summary,
                    responsibility.notes,
                    ...(responsibility.owns ?? []),
                ]
                    .flatMap((value) => value.split(/[\s,，。；;、:：/]+/))
                    .map((value) => value.trim())
                    .filter((value) => value.length >= 2);
                if (terms.length === 0)
                    return undefined;
                const text = `${doc.title ?? ""} ${doc.text}`.toLowerCase();
                return terms.some((term) => text.includes(term.toLowerCase()));
            },
            notifyOwner: (text) => this.sendToOwner(text),
            responsibilityFor: (chatId) => {
                const responsibility = this.config.platforms.feishu.groups.find((group) => group.chatId === chatId)?.responsibility;
                const inferred = this.groupKnowledge.get(chatId);
                return JSON.stringify(responsibility ??
                    (inferred
                        ? {
                            summary: `[推断] ${inferred.product}`,
                            owns: inferred.features,
                            dependsOn: inferred.dependsOn,
                            notes: `初始群画像，置信度 ${inferred.confidence}`,
                        }
                        : null));
            },
            groupKnowledgeFor: (chatId) => {
                const profile = this.groupKnowledge.get(chatId);
                if (!profile)
                    return undefined;
                return {
                    product: profile.product,
                    summary: profile.summary,
                    features: profile.features,
                    dependsOn: profile.dependsOn,
                    excludes: profile.excludes,
                    terms: profile.terms,
                    ownerDirection: profile.ownerDirection,
                    ownerKeywords: profile.ownerKeywords,
                    sessionEpoch: profile.sessionEpoch,
                };
            },
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
            readOnlyPermission: this.readOnlyPermission,
            conversationIdFor: (platform, chatId) => this.conversationIdFor(platform, chatId, "group"),
            loadMedia: (task) => this.replyService.loadTaskMedia(task),
            resolveProject: async (chatId) => {
                const project = await this.resolveProject(chatId);
                return {
                    worktree: project.worktree,
                    resolved: project.resolved,
                    ...(project.secondaryWorktrees
                        ? { secondaryWorktrees: project.secondaryWorktrees }
                        : {}),
                    ...(project.coreProjects ? { coreProjects: project.coreProjects } : {}),
                    ...(project.writableProjects ? { writableProjects: project.writableProjects } : {}),
                    ...(project.referenceProjects
                        ? { referenceProjects: project.referenceProjects }
                        : {}),
                    ...(project.workspace ? { workspace: true } : {}),
                    ...(project.workspaceRoot ? { workspaceRoot: project.workspaceRoot } : {}),
                    ...(project.workspaceProjects
                        ? { workspaceProjects: project.workspaceProjects }
                        : {}),
                    ...(project.workspaceDocs ? { workspaceDocs: project.workspaceDocs } : {}),
                };
            },
            memory: this.memory,
            projectId: (chatId) => this.projectStore.get(chatId)?.projectId,
            chatLabelFor: async (chatId) => {
                const configured = this.config.platforms.feishu.groups.find((group) => group.chatId === chatId);
                return configured?.name ?? (await this.notificationService.fetchChatName(chatId));
            },
            senderLabelFor: (userId, messageId) => this.resolveSenderLabel(userId, messageId),
            messageLinkFor: (_chatId, messageId) => this.resolveMessageLink(messageId),
            startAnalysis: (task) => {
                this.track(this.taskService.analyzeTask(task)).catch((error) => {
                    this.logger.error("task analysis failed", {
                        taskId: task.id,
                        error: toErrorMessage(error),
                    });
                });
            },
            sendToApprover: (text) => this.sendToApprover(text),
            sendOwnerNotification: (view) => this.notificationService.sendOwnerNotification(view),
            sendOwnerNotificationResult: (view) => this.notificationService.sendOwnerNotificationResult(view),
            linkTaskMessage: (chatId, messageId, taskId) => this.taskLinks.linkMessage(chatId, messageId, taskId),
            publishTaskEvent: ({ chatId, taskId, type, payload }) => this.taskEvents.publish(chatId, { type, taskId, chatId, ...(payload ? { payload } : {}) }),
            recordTaskNotification: async (input) => this.taskLinks.recordNotification(input),
            startTaskRun: async (input) => this.taskLinks.startRun(input),
            attachTaskRunSession: async (runId, sessionId, chatId) => this.taskLinks.attachRunSession(chatId, runId, sessionId),
            finishTaskRun: async (runId, chatId, status) => this.taskLinks.finishRun(chatId, runId, status),
            touchTaskRun: async (runId, chatId) => this.taskLinks.touchRun(chatId, runId),
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
            executionPermission: this.executionPermission,
            executionPermissionFor: (input) => executionPermissionFor(this.executionPermission, input),
            readOnlyPermission: this.readOnlyPermission,
            conversationIdFor: (platform, chatId) => this.conversationIdFor(platform, chatId, "group"),
            latestAnalysis: (taskId) => this.latestAnalysis(taskId),
            resolveProject: async (chatId) => {
                const project = await this.resolveProject(chatId);
                return {
                    worktree: project.worktree,
                    resolved: project.resolved,
                    ...(project.workspace ? { workspace: true } : {}),
                    ...(project.workspaceRoot ? { workspaceRoot: project.workspaceRoot } : {}),
                    ...(project.workspaceProjects
                        ? { workspaceProjects: project.workspaceProjects }
                        : {}),
                    ...(project.workspaceDocs ? { workspaceDocs: project.workspaceDocs } : {}),
                };
            },
            sendToApprover: (text) => this.sendToApprover(text),
            sendToOwner: (text) => this.sendToOwner(text),
            startTaskRun: async (input) => this.taskLinks.startRun(input),
            attachTaskRunSession: async (runId, sessionId, chatId) => this.taskLinks.attachRunSession(chatId, runId, sessionId),
            finishTaskRun: async (runId, chatId, status) => this.taskLinks.finishRun(chatId, runId, status),
            touchTaskRun: async (runId, chatId) => this.taskLinks.touchRun(chatId, runId),
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
        this.permissionBridge = new PermissionBridge({
            bridge: this.options.bridge,
            sendToOwner: (text) => this.sendToOwner(text),
            sendPermissionCard: async (view) => {
                const rendered = this.options.platform.renderPermissionRequest?.(view);
                if (!rendered)
                    return false;
                const ownerId = this.ownerOpenId();
                if (!ownerId)
                    return false;
                await this.sendLimiter.take();
                await this.options.platform.send({ kind: "user", userId: ownerId }, rendered);
                return true;
            },
            onSessionCompacted: (sessionId) => {
                this.sessions.markContextDirty(sessionId);
                void this.sessions.flush().catch((error) => {
                    this.logger.warn("session context flush failed", {
                        sessionId,
                        error: toErrorMessage(error),
                    });
                });
            },
            logger: this.logger.child("permission-bridge"),
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
            sendOwnerNotification: (view) => this.notificationService.sendOwnerNotification(view),
            messageLinkFor: (_chatId, messageId) => this.resolveMessageLink(messageId),
            describeTask: (task) => this.describeTask(task),
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
                const group = this.config.platforms.feishu.groups.find((item) => item.chatId === chatId);
                const project = group?.project;
                const inferred = this.groupKnowledge.get(chatId);
                const responsibility = group?.responsibility
                    ? group.responsibility
                    : inferred
                        ? {
                            summary: `[推断] ${inferred.product}`,
                            owns: inferred.features,
                            dependsOn: inferred.dependsOn,
                            excludes: [],
                            notes: `初始群画像，置信度 ${inferred.confidence}`,
                        }
                        : undefined;
                return {
                    core: project
                        ? [...(project.primary ?? []), ...(project.core ?? [])].filter(Boolean)
                        : [],
                    reference: project
                        ? [...(project.reference ?? []), ...(project.secondary ?? [])]
                        : [],
                    ...(responsibility ? { responsibility } : {}),
                    ...(inferred
                        ? {
                            direction: inferred.summary || inferred.product,
                            ownerDirection: inferred.ownerDirection,
                            ownerKeywords: inferred.ownerKeywords.filter((keyword) => !isGenericOwnerKeyword(keyword, group ?? { enabled: true })),
                            ownProjects: [
                                ...new Set([
                                    ...(project?.primary ?? []),
                                    ...(project?.core ?? []),
                                    ...(group?.workspace?.projects ?? []).map((item) => item.name),
                                ]),
                            ],
                            excludedProjects: inferred.excludes,
                            terms: inferred.terms,
                        }
                        : {}),
                };
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
            readOnlyPermission: this.readOnlyPermission,
            ownerOpenId: () => this.ownerOpenId(),
            ownerName: () => this.ownerName(),
            resolveProject: (chatId) => this.resolveProject(chatId),
            conversationIdFor: (message) => this.conversationIdFor(message.platform, message.chat.id, message.chat.kind === "direct" ? "dm" : "group"),
            sendToOwner: (text, sourceMessageId) => this.sendToOwner(text, sourceMessageId),
            sendToApprover: (text) => this.sendToApprover(text),
            safeReply: (message, text) => this.safeReply(message, text),
            markProcessed: (message) => this.markProcessed(message),
            rememberFromMention: (message, intent, analysis) => this.rememberFromMention(message, intent, analysis),
            rememberOwnerTarget: (message) => {
                const ownerId = this.ownerOpenId();
                if (!ownerId)
                    return;
                this.ownerTargets.set({
                    ownerId,
                    chatId: message.chat.id,
                    conversationId: this.conversationIdFor(message.platform, message.chat.id, message.chat.kind === "direct" ? "dm" : "group"),
                    ...(message.chat.name ? { chatName: message.chat.name } : {}),
                    sourceMessageId: message.messageId,
                    updatedAt: Date.now(),
                });
            },
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
            isFileRelevant: (message, fileName, content) => this.isFileRelevant(message, fileName, content),
            onMessage: (message, wait) => this.onMessage(message, wait),
            markProcessed: (message) => this.markProcessed(message),
            sendToApprover: (text) => this.sendToApprover(text),
            sendToOwner: (text) => this.sendToOwner(text),
            sendOwnerNotification: (view) => this.notificationService.sendOwnerNotification(view),
        });
    }
    async refreshGroupKnowledge() {
        const allTasks = await this.tasks.list();
        for (const group of this.config.platforms.feishu.groups) {
            const existing = this.groupKnowledge.get(group.chatId);
            const tasks = allTasks
                .filter((task) => task.chatId === group.chatId)
                .slice(-10)
                .map((task) => truncate(task.title, 80));
            const project = group.project;
            const dependsOn = [
                ...(project?.core ?? []),
                ...(project?.reference ?? []),
                ...(project?.secondary ?? []),
            ].map((value) => value.split("/").filter(Boolean).pop() ?? value);
            const name = group.name ?? group.chatId;
            const product = name.replace(/^产品[-—]/, "").trim() || name;
            const known = inferFeatures(product);
            const explicit = group.responsibility;
            const features = explicit?.owns?.length
                ? explicit.owns
                : [...new Set([...(existing?.features ?? []), ...known])];
            const dependencies = explicit?.dependsOn?.length ? explicit.dependsOn : dependsOn;
            const terms = {
                ...inferTerms(product),
                ...(existing?.terms ?? {}),
            };
            const summary = explicit?.summary || existing?.summary || `[推断] ${product}`;
            const excludes = explicit?.excludes ?? existing?.excludes ?? [];
            const ownerDirection = group.ownerFocus?.summary || existing?.ownerDirection || "";
            const ownerKeywords = (group.ownerFocus?.keywords ?? []).length > 0
                ? [...new Set(group.ownerFocus.keywords)]
                : (existing?.ownerKeywords ?? []);
            const semanticChanged = Boolean(existing &&
                (existing.product !== product ||
                    existing.summary !== summary ||
                    existing.ownerDirection !== ownerDirection ||
                    JSON.stringify(existing.ownerKeywords) !== JSON.stringify(ownerKeywords) ||
                    JSON.stringify(existing.features) !== JSON.stringify(features) ||
                    JSON.stringify(existing.dependsOn) !== JSON.stringify([...new Set(dependencies)]) ||
                    JSON.stringify(existing.excludes) !== JSON.stringify(excludes) ||
                    JSON.stringify(existing.terms) !== JSON.stringify(terms)));
            const profile = {
                chatId: group.chatId,
                name,
                product,
                summary,
                features,
                tasks: [...new Set([...(existing?.tasks ?? []), ...tasks])].slice(-20),
                dependsOn: [...new Set(dependencies)],
                excludes,
                terms,
                ownerDirection,
                ownerKeywords,
                sessionEpoch: (existing?.sessionEpoch ?? 1) + (semanticChanged ? 1 : 0),
                source: explicit ? "owner" : "inferred",
                confidence: explicit ? 1 : known.length > 0 ? 0.6 : 0.3,
                updatedAt: Date.now(),
            };
            if (!existing ||
                semanticChanged ||
                JSON.stringify(existing.tasks) !== JSON.stringify(profile.tasks)) {
                await this.groupKnowledge.set(profile);
                this.logger.info("group profile refreshed", {
                    chatId: group.chatId,
                    product,
                    sessionEpoch: profile.sessionEpoch,
                    confidence: profile.confidence,
                });
            }
        }
    }
    conversationIdFor(platform, chatId, kind) {
        return conversationKey(conversationRefForChat(platform, chatId, kind, platform === "feishu" ? this.config.platforms.feishu.appId : undefined));
    }
    async ensureGroupWorkspace(chatId, name, project, workspace, conversationKind = "group") {
        const info = await this.groupState.ensure(chatId, name, {
            conversationId: this.conversationIdFor("feishu", chatId, conversationKind),
        });
        await this.groupWorkspace.ensure({
            chatId,
            name: info.name,
            stateGroupDir: info.dir,
            ...(workspace ? { workspace } : {}),
            ...(this.config.platforms.feishu.groups.find((group) => group.chatId === chatId)?.responsibility
                ? {
                    responsibility: this.config.platforms.feishu.groups.find((group) => group.chatId === chatId)?.responsibility,
                }
                : {}),
            ...(project
                ? {
                    project: {
                        primary: project.primary ?? [],
                        core: project.core ?? [],
                        reference: project.reference ?? [],
                        secondary: project.secondary ?? [],
                    },
                }
                : {}),
        });
    }
    jobStore(chatId) {
        const existing = this.jobsByGroup.get(chatId);
        if (existing)
            return existing;
        const store = new JobStore(this.groupState.dirFor(chatId), this.logger.child("jobs"));
        this.jobsByGroup.set(chatId, store);
        return store;
    }
    async recoverPendingJobs() {
        for (const [chatId, store] of this.jobsByGroup) {
            for (const job of store.list()) {
                if (job.status !== "queued" && job.status !== "running")
                    continue;
                if (!this.options.platform.fetchMessage)
                    continue;
                try {
                    const message = await this.options.platform.fetchMessage(job.messageId);
                    if (!message) {
                        await store.update(job.id, { status: "dead", error: "message unavailable on recovery" });
                        continue;
                    }
                    await store.update(job.id, { status: "queued" });
                    await this.ingest(message, true);
                }
                catch (error) {
                    await store.update(job.id, {
                        status: "failed",
                        error: toErrorMessage(error),
                        attempts: job.attempts + 1,
                    });
                }
            }
        }
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
    async describeTask(task) {
        const configured = this.config.platforms.feishu.groups.find((group) => group.chatId === task.chatId);
        const chatLabel = task.chatName && task.chatName !== task.chatId
            ? task.chatName
            : configured?.name ?? (await this.notificationService.fetchChatName(task.chatId)) ?? "群";
        const senderLabel = task.requester.displayName?.trim() ||
            (await this.resolveSenderLabel(task.requester.id, task.messageIds[0])) ||
            "成员";
        return { chatLabel, senderLabel };
    }
    async resolveMessageLink(messageId) {
        try {
            return (await this.options.platform.fetchMessage?.(messageId))?.messageLink;
        }
        catch {
            return undefined;
        }
    }
    async resolveSenderLabel(userId, messageId) {
        let label = "";
        try {
            label = (await this.options.platform.fetchUserName?.(userId)) ?? "";
        }
        catch {
            label = "";
        }
        if (!label && messageId && this.options.platform.fetchMessage) {
            try {
                label = (await this.options.platform.fetchMessage(messageId))?.sender.displayName ?? "";
            }
            catch {
                label = "";
            }
        }
        return label.trim() || undefined;
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
        this.chatContext.redact(key, event.messageId);
        if (event.chatId) {
            await this.evidence.redact(event.chatId, event.messageId);
            await this.tasks.redactMessage(event.chatId, event.messageId);
        }
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
    lastTaskArchiveSweep = 0;
    profileTimer;
    groupSyncTimer;
    async start() {
        if (this.started)
            return;
        await mkdir(join(this.stateDir, "scratch"), { recursive: true });
        await this.groupState.load();
        for (const info of this.groupState.all()) {
            if (info.name !== "私聊" || info.conversationId)
                continue;
            await this.groupState.ensure(info.chatId, info.name, {
                conversationId: this.conversationIdFor("feishu", info.chatId, "dm"),
            });
        }
        await this.dmContext.load();
        for (const group of this.config.platforms.feishu.groups) {
            await this.ensureGroupWorkspace(group.chatId, group.name, group.project, group.workspace);
            await this.jobStore(group.chatId).load();
        }
        await this.dedup.load();
        await this.historyMentions.load();
        await this.outbound.load();
        await this.sentReplies.load();
        await this.cursors.load();
        await this.sessions.load();
        await this.taskLinks.load();
        await this.tasks.load();
        await this.pending.load();
        await this.projectStore.load();
        await this.chatContext.load();
        await this.memory.load();
        await this.memory.migrateShards();
        await this.groupContext.load();
        await this.groupKnowledge.load();
        await this.refreshGroupKnowledge();
        await this.evidence.prune();
        await this.ownerAccess.load();
        await this.ownerTargets.load();
        await this.documentCache.load();
        await this.documentRefs.load();
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
        await this.recoverPendingJobs();
        this.poller.start();
        this.sweepTimer = setInterval(() => {
            void this.sweepExpiredApprovals();
            void this.sweepTaskArchive();
            void this.sweepTaskRuns();
            void this.sweepSessions();
            void this.chatContext.flush();
            void this.memory.flush();
        }, 60_000);
        this.sweepTimer.unref?.();
        this.profileTimer = setInterval(() => {
            void this.refreshGroupKnowledge();
        }, 10 * 60_000);
        this.profileTimer.unref?.();
        this.groupSyncTimer = setInterval(() => {
            void this.syncGroups();
        }, 30 * 60_000);
        this.groupSyncTimer.unref?.();
        void this.sweepExpiredApprovals();
        void this.sweepTaskArchive();
        void this.sweepTaskRuns();
        this.started = true;
        void this.permissionBridge.start();
        if (this.config.recovery.onStartup) {
            setImmediate(() => {
                void this.recoverOnStartup().catch((error) => {
                    this.logger.error("startup recovery failed", { error: toErrorMessage(error) });
                });
            });
        }
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
        this.permissionBridge.stop();
        if (this.sweepTimer)
            clearInterval(this.sweepTimer);
        this.sweepTimer = undefined;
        if (this.profileTimer)
            clearInterval(this.profileTimer);
        this.profileTimer = undefined;
        if (this.groupSyncTimer)
            clearInterval(this.groupSyncTimer);
        this.groupSyncTimer = undefined;
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
            this.taskLinks.flush(),
            Promise.resolve(this.taskLinks.close()),
            Promise.resolve(this.taskEvents.close()),
            this.tasks.close(),
            this.pending.flush(),
            this.projectStore.flush(),
            this.chatContext.flush(),
            this.memory.flush(),
            this.groupContext.flush(),
            this.ownerAccess.flush(),
            this.ownerTargets.flush(),
            this.documentCache.flush(),
            this.documentRefs.flush(),
            this.groupKnowledge.flush(),
        ]);
        this.logger.info("runtime stopped");
    }
    async onMessage(message, wait = false, force = false) {
        if (message.senderType !== "user")
            return;
        const chatName = await this.chatLabel(message);
        const groupConfig = this.config.platforms.feishu.groups.find((group) => group.chatId === message.chat.id);
        await this.ensureGroupWorkspace(message.chat.id, message.chat.kind === "direct" ? "私聊" : chatName, groupConfig?.project, groupConfig?.workspace, message.chat.kind === "direct" ? "dm" : "group");
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
            const targets = this.ownerTargets.list(message.sender.id);
            if (targets.length > 0 &&
                !message.replyToMessageId &&
                !/^\s*[/／]/.test(message.text)) {
                const lines = targets.map((target, index) => `${index + 1}. 群「${target.chatName ?? target.chatId}」 chatId=${target.chatId}${target.sourceMessageId ? ` messageId=${target.sourceMessageId}` : ""}`);
                message = {
                    ...message,
                    text: [
                        "（当前私聊关联目标，供参考；如果用户没有明确指定，不要猜测，先列出让主人选：）",
                        ...lines,
                        message.text,
                    ].join("\n"),
                };
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
        const jobStore = this.jobStore(message.chat.id);
        const jobRecord = await jobStore.create({
            id: message.messageId,
            chatId: message.chat.id,
            messageId: message.messageId,
            type: this.isMention(message) ? "chat" : "scan",
            priority: this.isMention(message) ? 1 : 5,
            status: "queued",
        });
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
                ? Math.max(this.config.concurrency.mentionTimeoutMs, /(私聊|只发我|不要发群|不要群里|私发我|分析给我)/.test(message.text)
                    ? 305_000
                    : (this.config.concurrency.intentTimeoutMs ?? 60_000) +
                        (this.config.concurrency.replyTimeoutMs ?? 120_000) +
                        5_000)
                : this.config.concurrency.scanTimeoutMs,
            run: async (signal) => {
                const unlink = this.linkAbort(controller, signal);
                try {
                    await jobStore.update(jobRecord.id, { status: "running", attempts: jobRecord.attempts + 1 });
                    this.logger.info("dispatch job started", { messageId: message.messageId, force });
                    if (controller.signal.aborted || (!force && this.dedup.has(dedupKey, message.chat.id))) {
                        await jobStore.update(jobRecord.id, { status: "done" });
                        return;
                    }
                    await this.handleMessage(message, controller.signal);
                    await jobStore.update(jobRecord.id, { status: "done" });
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
                await jobStore.update(jobRecord.id, { status: "failed", error: toErrorMessage(error) });
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
            void jobStore.update(jobRecord.id, { status: "failed", error: toErrorMessage(error) });
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
                const groupConfig = this.config.platforms.feishu.groups.find((item) => item.chatId === group.chatId);
                await this.ensureGroupWorkspace(group.chatId, group.name, groupConfig?.project, groupConfig?.workspace);
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
        const groupConfig = this.config.platforms.feishu.groups.find((group) => group.chatId === event.chatId);
        await this.ensureGroupWorkspace(event.chatId, event.name, groupConfig?.project, groupConfig?.workspace);
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
        await this.sendToOwner(`机器人已被加入群：${name}\n已自动加入处理白名单；后续启动会自动同步群列表。`);
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
    async getGroupKnowledge(arg) {
        await this.refreshGroupKnowledge();
        const profiles = this.groupKnowledge.list();
        if (profiles.length === 0)
            return "还没有群画像。";
        const key = arg.trim();
        const selected = key
            ? profiles.filter((profile) => profile.chatId === key || profile.name === key || profile.product === key)
            : profiles;
        if (selected.length === 0)
            return `找不到群画像：${key}`;
        return selected
            .map((profile) => [
            `群：${profile.name} (${profile.chatId})`,
            `产品：${profile.product}`,
            `摘要：${profile.summary}`,
            `功能：${profile.features.join("、") || "待补充"}`,
            `我的方向：${profile.ownerDirection || "待补充"}`,
            `我的关键词：${profile.ownerKeywords.join("、") || "待补充"}`,
            `依赖：${profile.dependsOn.join("、") || "无"}`,
            `排除：${profile.excludes.join("、") || "无"}`,
            `术语：${Object.entries(profile.terms)
                .map(([term, meaning]) => `${term}=${meaning}`)
                .join("；") || "待补充"}`,
            `会话代际：e${profile.sessionEpoch}`,
            `来源：${profile.source}｜置信度：${profile.confidence}｜更新：${new Date(profile.updatedAt).toLocaleString()}`,
        ].join("\n"))
            .join("\n\n");
    }
    listOwnerTargets() {
        const ownerId = this.ownerOpenId();
        if (!ownerId)
            return "owner 未绑定。";
        const targets = this.ownerTargets.list(ownerId);
        if (targets.length === 0)
            return "当前没有私聊关联目标。";
        return [
            "当前私聊目标：",
            ...targets.map((target, index) => `${index + 1}. ${target.chatName ?? target.chatId} chatId=${target.chatId}${target.sourceMessageId ? ` messageId=${target.sourceMessageId}` : ""}`),
            "用 /目标 <编号|chatId|messageId> 选择。",
        ].join("\n");
    }
    selectOwnerTarget(arg) {
        const ownerId = this.ownerOpenId();
        if (!ownerId)
            return "owner 未绑定。";
        const target = this.ownerTargets.select(ownerId, arg.trim());
        if (!target)
            return "找不到目标，用 /目标 查看列表。";
        return `已选择目标：${target.chatName ?? target.chatId} ${target.sourceMessageId ?? ""}`.trim();
    }
    async setGroupResponsibility(arg) {
        const match = arg.trim().match(/^(\S+)\s+([\s\S]+)$/);
        if (!match)
            return "用法：/职责 <群名|chatId> <职责说明>";
        const key = match[1] ?? "";
        const description = (match[2] ?? "").trim();
        const group = this.config.platforms.feishu.groups.find((item) => item.chatId === key || item.name === key);
        if (!group)
            return `找不到群：${key}`;
        group.responsibility = {
            summary: description,
            owns: [],
            dependsOn: [],
            excludes: [],
            notes: "",
        };
        const path = this.options.loaded.path;
        if (path) {
            try {
                const raw = await readJsonFile(path, {});
                const groups = raw.platforms?.feishu?.groups;
                if (Array.isArray(groups)) {
                    const target = groups.find((item) => item?.chatId === group.chatId);
                    if (target)
                        target.responsibility = group.responsibility;
                }
                await writeJsonAtomic(path, raw);
            }
            catch (error) {
                this.logger.warn("failed to persist group responsibility", {
                    chatId: group.chatId,
                    error: toErrorMessage(error),
                });
            }
        }
        await this.ensureGroupWorkspace(group.chatId, group.name, group.project, group.workspace);
        await this.refreshGroupKnowledge();
        return `已设置「${group.name ?? group.chatId}」职责：${description}`;
    }
    async analyzePendingTask(arg) {
        const taskId = arg.trim();
        const task = await this.tasks.get(taskId);
        if (!task)
            return `找不到任务：${taskId}`;
        if (["analyzing", "executing", "verifying"].includes(task.state)) {
            return `任务正在处理中：${task.id} [${task.state}]`;
        }
        task.archivedAt = undefined;
        task.archivedReason = undefined;
        task.state = "analyzing";
        task.updatedAt = Date.now();
        await this.tasks.save(task);
        this.track(this.taskService.analyzeTask(task)).catch((error) => {
            this.logger.error("manual task analysis failed", {
                taskId: task.id,
                error: toErrorMessage(error),
            });
        });
        return `已开始分析任务：${task.title}\n${task.id}`;
    }
    async analyzeGroupMessages(arg) {
        if (!this.options.platform.capabilities().groupHistory) {
            return "当前平台不支持群历史分析。";
        }
        const match = arg.trim().match(/^(\S+)(?:\s+(\d{1,3}))?$/);
        if (!match)
            return "用法：/群消息分析 <群名关键词> [数量]";
        const key = match[1] ?? "";
        const requested = match[2] ? Math.max(1, Math.min(200, Number(match[2]))) : 200;
        const candidates = this.matchGroups(key);
        if (candidates.length === 0) {
            if (key.startsWith("oc_"))
                return "请用群名关键词查询，不需要输入 chatId。";
            return `找不到群：${key}\n可用群：\n${this.config.platforms.feishu.groups.map((group) => `- ${group.name ?? group.chatId}`).join("\n")}`;
        }
        if (candidates.length > 1) {
            return [
                "匹配到多个群，请用更完整的群名：",
                ...candidates.map((group) => `- ${group.name ?? "未命名群"}`),
            ].join("\n");
        }
        const group = candidates[0];
        const endTime = Date.now();
        const startTime = endTime - 7 * 24 * 3600_000;
        let result;
        try {
            result = await this.options.platform.listMessages({
                chatId: group.chatId,
                startTime,
                endTime,
                maxPages: 5,
                maxMessages: requested,
            });
        }
        catch (error) {
            return `读取群消息失败：${toErrorMessage(error)}`;
        }
        const count = await this.scanService.runManualDigest(result.messages);
        if (count === 0)
            return `没有找到可分析消息。\n群：${group.name ?? "未命名群"}`;
        return `已生成群消息分析卡片。\n群：${group.name ?? "未命名群"}\n本次候选：${count} 条`;
    }
    async queryGroupMessages(arg) {
        return this.queryConversationMessages(arg, false);
    }
    async queryMentions(arg) {
        return this.queryConversationMessages(arg, true);
    }
    normalizeGroupQuery(value) {
        return value
            .replace(/^产品[-—]/, "")
            .replace(/[\s_\-—]+/g, "")
            .toLowerCase();
    }
    matchGroups(key) {
        if (key.startsWith("oc_"))
            return [];
        const normalized = this.normalizeGroupQuery(key);
        if (!normalized)
            return [];
        const all = this.config.platforms.feishu.groups.filter((group) => group.enabled);
        const scored = all
            .map((group) => {
            const product = this.groupKnowledge.get(group.chatId)?.product ?? "";
            const names = [group.name ?? "", product]
                .filter(Boolean)
                .map((value) => this.normalizeGroupQuery(value));
            const exact = names.some((name) => name === normalized);
            const contains = names.some((name) => name.includes(normalized));
            return { group, score: exact ? 2 : contains ? 1 : 0 };
        })
            .filter((item) => item.score > 0);
        const best = Math.max(0, ...scored.map((item) => item.score));
        return scored.filter((item) => item.score === best).map((item) => item.group);
    }
    async queryConversationMessages(arg, mentionsOnly) {
        if (!this.options.platform.capabilities().groupHistory) {
            return "当前平台不支持群历史查询。";
        }
        const match = arg.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
        if (!match)
            return mentionsOnly
                ? "用法：/提及 <群名关键词> [数量]"
                : "用法：/群消息 <群名关键词> [关键词] [数量]";
        const key = match[1] ?? "";
        let rest = (match[2] ?? "").trim();
        let limit = 20;
        const limitMatch = rest.match(/^(.*?)(?:\s+|^)(\d{1,3})$/);
        if (limitMatch) {
            limit = Math.max(1, Math.min(50, Number(limitMatch[2])));
            rest = (limitMatch[1] ?? "").trim();
        }
        const candidates = this.matchGroups(key);
        if (candidates.length === 0) {
            if (key.startsWith("oc_")) {
                return "请用群名关键词查询，不需要输入 chatId。";
            }
            return `找不到群：${key}\n可用群：\n${this.config.platforms.feishu.groups.map((group) => `- ${group.name ?? group.chatId}`).join("\n")}`;
        }
        if (candidates.length > 1) {
            return [
                `匹配到多个群，请用更完整的群名：`,
                ...candidates.map((group) => `- ${group.name ?? "未命名群"}`),
            ].join("\n");
        }
        const group = candidates[0];
        const chatId = group.chatId;
        const endTime = Date.now();
        const startTime = endTime - 7 * 24 * 3600_000;
        let result;
        try {
            result = await this.options.platform.listMessages({
                chatId,
                startTime,
                endTime,
                maxPages: 5,
                maxMessages: 200,
            });
        }
        catch (error) {
            return `查询群消息失败：${toErrorMessage(error)}`;
        }
        const ownerId = this.ownerOpenId();
        const botId = this.options.platform.getBotOpenId?.() ??
            this.config.platforms.feishu.botOpenId;
        const keyword = rest.trim();
        const messages = result.messages
            .filter((message) => message.senderType === "user" && message.text.trim())
            .filter((message) => !mentionsOnly ||
            message.mentions.some((mention) => mention.id === ownerId || mention.id === botId))
            .filter((message) => !keyword ||
            message.text.includes(keyword) ||
            (message.sender.displayName ?? "").includes(keyword))
            .slice(-limit);
        if (messages.length === 0) {
            return `没有找到符合条件的群消息。\n群：${group.name ?? "未命名群"}\n时间范围：最近 7 天${keyword ? `\n关键词：${keyword}` : ""}`;
        }
        const names = new Map();
        for (const message of messages) {
            if (message.sender.displayName) {
                names.set(message.sender.id, message.sender.displayName);
                continue;
            }
            if (names.has(message.sender.id))
                continue;
            try {
                names.set(message.sender.id, (await this.options.platform.fetchUserName?.(message.sender.id)) ?? "成员");
            }
            catch {
                names.set(message.sender.id, "成员");
            }
        }
        const title = mentionsOnly ? "@提及" : "群消息";
        return [
            `${title}｜群：${group.name ?? "未命名群"}`,
            `时间范围：最近 7 天${keyword ? `｜关键词：${keyword}` : ""}｜显示最近 ${messages.length} 条`,
            `打开群聊：https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(chatId)}`,
            "",
            ...messages.map((message) => `${formatLocalTime(message.createdAt)} ${names.get(message.sender.id) ?? "成员"}：${truncate(message.text.replace(/\s+/g, " "), 300)}`),
        ].join("\n");
    }
    async setOwnerFocus(arg, kind) {
        const match = arg.trim().match(/^(\S+)\s+([\s\S]+)$/);
        if (!match) {
            return kind === "direction"
                ? "用法：/方向 <群名|chatId> <说明>"
                : "用法：/关键词 <群名|chatId> <关键词1,关键词2>";
        }
        const key = match[1] ?? "";
        const value = (match[2] ?? "").trim();
        if (!value)
            return kind === "direction" ? "方向不能为空。" : "关键词不能为空。";
        const group = this.config.platforms.feishu.groups.find((item) => item.chatId === key || item.name === key);
        if (!group)
            return `找不到群：${key}`;
        const existing = group.ownerFocus ?? { summary: "", keywords: [] };
        group.ownerFocus =
            kind === "direction"
                ? { ...existing, summary: value }
                : {
                    ...existing,
                    keywords: [...new Set(value.split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean))],
                };
        await this.persistGroupOwnerFocus(group);
        await this.refreshGroupKnowledge();
        const profile = this.groupKnowledge.get(group.chatId);
        const epoch = profile?.sessionEpoch ?? 1;
        return `已设置「${group.name ?? group.chatId}」${kind === "direction" ? "研发方向" : "研发关键词"}：${kind === "direction" ? group.ownerFocus.summary : group.ownerFocus.keywords.join("、")}\n会话代际：e${epoch}`;
    }
    async persistGroupOwnerFocus(group) {
        const path = this.options.loaded.path;
        if (!path)
            return;
        try {
            const raw = await readJsonFile(path, {});
            const groups = raw.platforms?.feishu?.groups;
            if (Array.isArray(groups)) {
                const target = groups.find((item) => item?.chatId === group.chatId);
                if (target)
                    target.ownerFocus = group.ownerFocus;
            }
            await writeJsonAtomic(path, raw);
        }
        catch (error) {
            this.logger.warn("failed to persist owner focus", {
                chatId: group.chatId,
                error: toErrorMessage(error),
            });
        }
    }
    taskGroupFromKey(key) {
        const value = key.trim();
        if (!value)
            return undefined;
        const exact = this.config.platforms.feishu.groups.find((group) => group.name === value || group.chatId === value);
        if (exact)
            return exact;
        const matches = this.matchGroups(value);
        return matches.length === 1 ? matches[0] : undefined;
    }
    taskScope(arg, defaultStates = []) {
        const tokens = arg.trim().split(/\s+/).filter(Boolean);
        const dayMatch = arg.match(/(\d{1,4})\s*(?:天|日)/);
        const states = [...defaultStates];
        let statesProvided = false;
        let group;
        let groupKey;
        let limit = 20;
        let olderThanDays = dayMatch ? Number(dayMatch[1]) : undefined;
        let includeArchived = false;
        let confirm = false;
        let taskId;
        for (const token of tokens) {
            if (dayMatch && (token === dayMatch[1] || token === "天" || token === "日"))
                continue;
            if (token === "确认" || token === "确认归档") {
                confirm = true;
                continue;
            }
            if (token === "全部" || token === "归档") {
                includeArchived = true;
                continue;
            }
            if (token.startsWith("task_")) {
                taskId = token;
                continue;
            }
            if (/^\d{1,4}天$/.test(token) || /^\d{1,4}日$/.test(token)) {
                olderThanDays = Number(token.replace(/[天日]/g, ""));
                continue;
            }
            if (/^\d{1,3}$/.test(token)) {
                limit = Math.max(1, Math.min(50, Number(token)));
                continue;
            }
            if (["candidate", "analyzing", "needs_info", "awaiting_approval", "approved", "executing", "verifying", "awaiting_merge", "done", "rejected", "failed", "canceled", "expired"].includes(token)) {
                if (!statesProvided) {
                    states.length = 0;
                    statesProvided = true;
                }
                if (!states.includes(token))
                    states.push(token);
                continue;
            }
            if (!groupKey)
                groupKey = token;
        }
        if (taskId)
            states.length = 0;
        if (groupKey)
            group = this.taskGroupFromKey(groupKey);
        return {
            ...(group ? { group } : {}),
            ...(groupKey ? { groupKey } : {}),
            states,
            limit,
            ...(olderThanDays !== undefined ? { olderThanDays } : {}),
            includeArchived,
            confirm,
            ...(taskId ? { taskId } : {}),
        };
    }
    taskMatchesScope(task, scope) {
        if (task.archivedAt && !scope.includeArchived)
            return false;
        if (scope.taskId && task.id !== scope.taskId)
            return false;
        if (scope.group && task.chatId !== scope.group.chatId)
            return false;
        if (scope.states.length > 0 && !scope.states.includes(task.state))
            return false;
        if (scope.olderThanDays !== undefined) {
            const cutoff = Date.now() - scope.olderThanDays * 86_400_000;
            if (task.updatedAt > cutoff)
                return false;
        }
        return true;
    }
    async listTasks(arg) {
        const scope = this.taskScope(arg);
        if (scope.groupKey && !scope.group)
            return `找不到群：${scope.groupKey}`;
        const tasks = (await this.tasks.list())
            .filter((task) => this.taskMatchesScope(task, scope))
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, scope.limit);
        if (tasks.length === 0)
            return "没有符合条件的任务。";
        const counts = new Map();
        for (const task of tasks)
            counts.set(task.state, (counts.get(task.state) ?? 0) + 1);
        const lines = [
            `任务：${tasks.length} 条${scope.group ? `（${scope.group.name ?? scope.group.chatId}）` : ""}${scope.includeArchived ? "，含归档" : ""}`,
            ...[...counts.entries()].map(([state, count]) => `${state}=${count}`),
            "",
            ...tasks.map((task) => {
                const group = task.chatName ?? this.config.platforms.feishu.groups.find((item) => item.chatId === task.chatId)?.name ?? task.chatId;
                return `- ${task.state}｜${group}｜${truncate(task.title, 80)}｜${task.id}${task.archivedAt ? "｜已归档" : ""}`;
            }),
            "",
            "重新分析：/任务分析 <taskId|群名> [状态] [数量]",
            "归档：/任务归档 <群名|taskId> [状态] [天数] 确认",
        ];
        return lines.join("\n");
    }
    async reanalyzeTasks(arg) {
        const scope = this.taskScope(arg, ["candidate", "needs_info", "awaiting_approval", "failed", "expired"]);
        if (scope.groupKey && !scope.group)
            return `找不到群：${scope.groupKey}`;
        const tasks = (await this.tasks.list())
            .filter((task) => this.taskMatchesScope(task, scope))
            .sort((a, b) => a.updatedAt - b.updatedAt)
            .slice(0, Math.min(10, scope.limit));
        if (tasks.length === 0)
            return "没有可重新分析的任务。";
        const started = [];
        const skipped = [];
        for (const task of tasks) {
            if (["executing", "approved", "verifying", "awaiting_merge"].includes(task.state)) {
                skipped.push(task.id);
                continue;
            }
            this.pending.deleteForTask(task.id);
            task.state = "analyzing";
            task.archivedAt = undefined;
            task.archivedReason = undefined;
            task.lastAnalyzedAt = Date.now();
            task.updatedAt = Date.now();
            await this.tasks.save(task);
            void this.taskEvents.publish(task.chatId, {
                type: "task.reanalyze_requested",
                taskId: task.id,
                chatId: task.chatId,
                payload: { actor: "owner" },
            });
            void this.track(this.analyzeTask(task)).catch((error) => {
                this.logger.error("manual task reanalysis failed", {
                    taskId: task.id,
                    error: toErrorMessage(error),
                });
            });
            started.push(task.id);
        }
        await this.pending.flush();
        return [
            `已启动重新分析：${started.length} 条`,
            ...(skipped.length > 0 ? [`跳过执行中：${skipped.length} 条`] : []),
            ...(started.length > 0 ? [`任务：${started.join("、")}`] : []),
        ].join("\n");
    }
    async archiveTasks(arg) {
        const scope = this.taskScope(arg, ["candidate", "needs_info"]);
        if (scope.groupKey && !scope.group)
            return `找不到群：${scope.groupKey}`;
        const tasks = (await this.tasks.list())
            .filter((task) => this.taskMatchesScope(task, scope))
            .filter((task) => !task.archivedAt)
            .filter((task) => !["executing", "approved", "verifying", "awaiting_merge"].includes(task.state))
            .sort((a, b) => a.updatedAt - b.updatedAt)
            .slice(0, Math.min(50, scope.limit));
        if (tasks.length === 0)
            return "没有可归档的任务。";
        if (!scope.confirm) {
            return [
                `准备归档 ${tasks.length} 条（不会删除）：`,
                ...tasks.slice(0, 20).map((task) => `- ${task.state}｜${truncate(task.title, 70)}｜${task.id}`),
                "",
                "确认请追加：确认",
            ].join("\n");
        }
        for (const task of tasks) {
            this.pending.deleteForTask(task.id);
            task.archivedAt = Date.now();
            task.archivedReason = `owner_archive:${scope.olderThanDays ?? "manual"}`;
            task.updatedAt = Date.now();
            await this.tasks.save(task);
            void this.taskEvents.publish(task.chatId, {
                type: "task.archived",
                taskId: task.id,
                chatId: task.chatId,
                payload: { reason: task.archivedReason },
            });
        }
        await this.pending.flush();
        return `已归档 ${tasks.length} 条任务；任务文件和审计均保留，可 /任务恢复 恢复。`;
    }
    async taskSessions(arg) {
        const taskId = arg.trim();
        const task = await this.tasks.get(taskId);
        if (!task)
            return `找不到任务：${taskId}`;
        const links = this.taskLinks.findByTask(taskId);
        const run = this.taskLinks.currentRun(taskId);
        return [
            `任务：${task.id}`,
            `状态：${task.state}${task.archivedAt ? "（已归档）" : ""}`,
            `标题：${task.title}`,
            ...(run
                ? [`当前 run：${run.role}/${run.stage} ${run.status}${run.sessionId ? ` session=${run.sessionId}` : ""}`]
                : []),
            ...(links.length > 0
                ? ["关联 session：", ...links.map((item) => `- ${item.role}: ${item.sessionId}`)]
                : ["关联 session：暂无记录"]),
        ].join("\n");
    }
    async restoreTask(taskId) {
        const task = await this.tasks.get(taskId.trim());
        if (!task)
            return `找不到任务：${taskId}`;
        task.archivedAt = undefined;
        task.archivedReason = undefined;
        task.updatedAt = Date.now();
        await this.tasks.save(task);
        return `已恢复任务：${task.id}\n${task.title}`;
    }
    async sweepTaskRuns() {
        const stallMs = 5 * 60_000;
        const stale = this.taskLinks.staleRuns(stallMs);
        for (const run of stale) {
            this.taskLinks.markRunStalled(run.chatId, run.id);
            const task = await this.tasks.get(run.taskId);
            await this.sendToOwner([
                "任务运行停滞",
                `任务：${task?.title ?? run.taskId}`,
                `阶段：${run.role}/${run.stage}`,
                `session：${run.sessionId ?? "未绑定"}`,
                `已超过 ${Math.round(stallMs / 60_000)} 分钟无心跳`,
                "请检查 OpenCode session，确认继续或取消。",
            ].join("\n"));
            await this.audit.append({
                actor: { system: true },
                action: "task_run_stalled",
                taskId: run.taskId,
                details: { runId: run.id, role: run.role, stage: run.stage },
            }).catch((error) => {
                this.logger.warn("task run stall audit failed", { error: toErrorMessage(error) });
            });
        }
    }
    async sweepTaskArchive() {
        const config = this.config.taskArchive;
        if (config?.enabled === false)
            return;
        const sweepMs = (config?.sweepHours ?? 12) * 3_600_000;
        if (Date.now() - this.lastTaskArchiveSweep < sweepMs)
            return;
        this.lastTaskArchiveSweep = Date.now();
        const cleaned = this.taskLinks.cleanup(config?.linkRetentionDays ?? 90, config?.eventRetentionDays ?? 180);
        if (cleaned.links > 0 || cleaned.events > 0) {
            this.logger.info("task state cache cleaned", cleaned);
        }
        const needsInfoDays = config?.needsInfoAfterDays ?? 90;
        const approvalDays = config?.awaitingApprovalAfterDays ?? 30;
        const terminalDays = config?.terminalAfterDays ?? 90;
        const terminal = new Set(["done", "rejected", "canceled", "expired", "failed"]);
        const skip = new Set(["executing", "approved", "verifying", "awaiting_merge"]);
        const tasks = await this.tasks.list();
        let archived = 0;
        for (const task of tasks) {
            if (task.archivedAt || skip.has(task.state))
                continue;
            const ageDays = (Date.now() - task.updatedAt) / 86_400_000;
            const threshold = task.state === "candidate"
                ? (config?.candidateAfterDays ?? 14)
                : task.state === "needs_info"
                    ? needsInfoDays
                    : task.state === "awaiting_approval"
                        ? approvalDays
                        : terminal.has(task.state)
                            ? terminalDays
                            : Number.POSITIVE_INFINITY;
            if (ageDays < threshold)
                continue;
            this.pending.deleteForTask(task.id);
            task.archivedAt = Date.now();
            task.archivedReason = `ttl:${task.state}`;
            task.updatedAt = Date.now();
            await this.tasks.save(task);
            archived++;
        }
        if (archived > 0) {
            await this.pending.flush();
            await this.audit.append({
                actor: { system: true },
                action: "tasks_archived",
                details: { count: archived, reason: "ttl" },
            }).catch((error) => {
                this.logger.warn("task archive audit failed", { error: toErrorMessage(error) });
            });
            this.logger.info("tasks archived by ttl", { count: archived });
        }
        const purged = this.taskLinks.purgeTasks({
            candidateDays: config?.purgeCandidateAfterDays ?? 90,
            needsInfoDays: config?.purgeNeedsInfoAfterDays ?? 180,
            awaitingApprovalDays: config?.purgeAwaitingApprovalAfterDays ?? 90,
            terminalDays: config?.purgeTerminalAfterDays ?? 180,
            archivedDays: config?.purgeArchivedAfterDays ?? 30,
        });
        if (purged.length > 0) {
            for (const item of purged) {
                this.tasks.forgetTask(item.chatId, item.taskId);
                this.pending.deleteForTask(item.taskId);
                void this.sessionManager.archiveTaskChildren(item.taskId).catch((error) => {
                    this.logger.warn("purged task session archive failed", {
                        taskId: item.taskId,
                        error: toErrorMessage(error),
                    });
                });
            }
            await this.pending.flush();
            await this.audit.append({
                actor: { system: true },
                action: "tasks_purged",
                details: { count: purged.length },
            }).catch((error) => {
                this.logger.warn("task purge audit failed", { error: toErrorMessage(error) });
            });
            this.logger.info("tasks purged by ttl", { count: purged.length });
        }
        const tombstones = this.taskLinks.cleanupTombstones(config?.tombstoneRetentionDays ?? 720);
        if (tombstones > 0) {
            this.logger.info("task tombstones cleaned", { count: tombstones });
        }
    }
    findGroupMentionedIn(text) {
        const compact = this.normalizeGroupQuery(text);
        for (const group of this.config.platforms.feishu.groups) {
            if (!group.enabled)
                continue;
            const names = [group.name ?? "", this.groupKnowledge.get(group.chatId)?.product ?? ""]
                .filter(Boolean)
                .map((value) => this.normalizeGroupQuery(value));
            if (names.some((name) => name && compact.includes(name)))
                return group;
        }
        return undefined;
    }
    async handleGroupLookupIntent(message) {
        if (message.chat.kind !== "direct")
            return undefined;
        if (!/(群|群里|群消息|东海忠|找一下|查一下|搜一下)/.test(message.text))
            return undefined;
        if (!/(找|查|搜|看|谁|哪|上).*?(群|消息|东海忠)|群.*?(找|查|搜)/.test(message.text)) {
            return undefined;
        }
        const group = this.findGroupMentionedIn(message.text);
        if (!group)
            return "请说明群名，例如：去产品-流分装置群里找东海忠关于 Kafka 的消息。";
        const keyword = /kafka/i.test(message.text)
            ? "kafka"
            : message.text.includes("东海忠")
                ? "东海忠"
                : "";
        return this.queryGroupMessages(`${group.name ?? group.chatId}${keyword ? ` ${keyword}` : ""} 50`);
    }
    taskIdsFrom(text) {
        return [...new Set(text.match(/task_[a-f0-9]{6,}/gi) ?? [])];
    }
    async handleTaskPurgeIntent(message) {
        if (message.chat.kind !== "direct" || message.sender.id !== this.ownerOpenId())
            return undefined;
        if (!/(删除|清理|清掉|删掉)/.test(message.text))
            return undefined;
        const ids = this.taskIdsFrom(message.text);
        if (ids.length === 0)
            return undefined;
        return this.purgeTaskIds(ids, "owner_dm");
    }
    async cancelTasks(arg) {
        const ids = this.taskIdsFrom(arg);
        if (ids.length === 0)
            return "用法：/任务取消 <taskId,...>";
        const client = this.options.bridge.getClient();
        const canceled = [];
        const skipped = [];
        for (const id of ids) {
            const task = await this.tasks.get(id);
            if (!task) {
                skipped.push(id);
                continue;
            }
            if (["done", "rejected", "canceled", "expired"].includes(task.state)) {
                skipped.push(id);
                continue;
            }
            for (const link of this.taskLinks.findByTask(id)) {
                try {
                    await client.session?.abort({ sessionID: link.sessionId });
                }
                catch (error) {
                    this.logger.warn("task cancel session abort failed", {
                        taskId: id,
                        sessionId: link.sessionId,
                        error: toErrorMessage(error),
                    });
                }
            }
            task.state = "canceled";
            task.updatedAt = Date.now();
            await this.tasks.save(task);
            this.pending.deleteForTask(id);
            await this.sessionManager.archiveTaskChildren(id);
            await this.audit.append({
                actor: { system: true },
                action: "task_canceled",
                taskId: id,
                details: { actor: "owner" },
            });
            canceled.push(id);
        }
        await this.pending.flush();
        return [
            `已取消任务：${canceled.length} 条`,
            ...(canceled.length > 0 ? [canceled.join("、")] : []),
            ...(skipped.length > 0 ? [`跳过：${skipped.join("、")}`] : []),
        ].join("\n");
    }
    async handleTaskCancelIntent(message) {
        if (message.chat.kind !== "direct" || message.sender.id !== this.ownerOpenId())
            return undefined;
        if (!/(取消|停止|停下|别跑了|终止)/.test(message.text))
            return undefined;
        const ids = this.taskIdsFrom(message.text);
        if (ids.length === 0)
            return undefined;
        return this.cancelTasks(ids.join(" "));
    }
    async purgeTasks(arg) {
        const ids = this.taskIdsFrom(arg);
        if (ids.length === 0) {
            return "用法：/任务清理 <taskId,...> [确认]";
        }
        const confirmed = /(^|\s)确认(\s|$)/.test(arg);
        if (!confirmed) {
            return [
                `准备真正删除 ${ids.length} 条任务（保留 tombstone 和审计）：`,
                ...ids.map((id) => `- ${id}`),
                "",
                "确认请执行：/任务清理 " + ids.join(",") + " 确认",
            ].join("\n");
        }
        return this.purgeTaskIds(ids, "owner_command");
    }
    async purgeTaskIds(ids, reason) {
        const purged = this.taskLinks.purgeTaskIds(ids, reason);
        for (const item of purged) {
            this.tasks.forgetTask(item.chatId, item.taskId);
            this.pending.deleteForTask(item.taskId);
            void this.sessionManager.archiveTaskChildren(item.taskId).catch((error) => {
                this.logger.warn("purged task session archive failed", {
                    taskId: item.taskId,
                    error: toErrorMessage(error),
                });
            });
        }
        await this.pending.flush();
        const skipped = ids.filter((id) => !purged.some((item) => item.taskId === id));
        return [
            `已清理任务：${purged.length} 条`,
            ...(skipped.length > 0 ? [`跳过：${skipped.join("、")}（执行中或不存在）`] : []),
        ].join("\n");
    }
    async handlePermissionReply(message) {
        if (message.chat.kind !== "direct" || message.sender.id !== this.ownerOpenId())
            return undefined;
        if (message.text.trim().startsWith("/"))
            return undefined;
        if (!this.permissionBridge.pendingCount())
            return undefined;
        const decision = parsePermissionReply(message.text);
        if (!decision)
            return undefined;
        if (this.permissionBridge.pendingCount() > 1) {
            return "当前有多个权限请求，请回复 /允许 <requestId> 或 /拒绝 <requestId>。";
        }
        return this.permissionBridge.reply("", decision === "deny" ? "reject" : "once");
    }
    async handleTaskAdminIntent(text) {
        if (!this.taskAdmin)
            return undefined;
        const intent = await this.taskAdmin.infer(text);
        if (!intent || intent.confidence < 0.5)
            return undefined;
        if ((intent.action === "reanalyze" || intent.action === "archive") && !intent.group) {
            return "请说明要处理哪个群，例如：把产品-流分装置的 needs_info 任务重新分析一下。";
        }
        const parts = [
            intent.group ?? "",
            ...intent.states,
            ...(intent.olderThanDays !== undefined ? [`${intent.olderThanDays}天`] : []),
            String(intent.limit),
        ].filter(Boolean);
        if (intent.action === "list")
            return this.listTasks(parts.join(" "));
        if (intent.action === "reanalyze")
            return this.reanalyzeTasks(parts.join(" "));
        if (intent.action === "archive")
            return this.archiveTasks(parts.join(" "));
        if (intent.action === "restore")
            return this.restoreTask(intent.group ?? "");
        return undefined;
    }
    async diagnoseProject(arg) {
        const key = arg.trim();
        const group = this.config.platforms.feishu.groups.find((item) => item.chatId === key || item.name === key);
        if (!group)
            return `找不到群：${key}`;
        const project = group.project;
        const paths = [];
        for (const path of project?.primary ?? [])
            paths.push(["primary", path]);
        for (const path of project?.core ?? [])
            paths.push(["core", path]);
        for (const path of project?.reference ?? [])
            paths.push(["reference", path]);
        for (const path of project?.secondary ?? [])
            paths.push(["secondary", path]);
        for (const item of group.workspace?.projects ?? []) {
            paths.push(["workspace", item.path]);
        }
        const worktree = group.workspace?.root ?? project?.primary?.[0];
        const configPath = join(process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config"), "opencode", "opencode.json");
        let fsRoots = [];
        let fsError = "";
        try {
            const raw = await readJsonFile(configPath, {});
            const command = raw?.mcp?.["fs-root"]?.command;
            if (Array.isArray(command)) {
                fsRoots = command.filter((item) => typeof item === "string" && isAbsolute(item));
            }
        }
        catch (error) {
            fsError = toErrorMessage(error);
        }
        const normalize = (path) => resolve(path).replace(/\/+$/, "").toLowerCase();
        const roots = fsRoots.map(normalize);
        const covered = (path) => {
            const normalized = normalize(path);
            return roots.some((root) => normalized === root || normalized.startsWith(`${root}/`));
        };
        const lines = [`配置诊断：${group.name ?? group.chatId}`];
        if (worktree) {
            const info = await stat(resolve(worktree)).catch(() => undefined);
            lines.push(`worktree：${worktree}${info?.isDirectory() ? "" : "（不存在）"}`);
        }
        if (paths.length === 0) {
            lines.push("项目路径：未配置");
        }
        else {
            lines.push("项目路径：");
            for (const [role, path] of paths) {
                const info = await stat(resolve(path)).catch(() => undefined);
                const exists = Boolean(info?.isDirectory());
                const inRoot = covered(path);
                lines.push(`- ${role}: ${path} [${exists ? "存在" : "不存在"}] [fs-root ${inRoot ? "已覆盖" : "未覆盖"}]`);
            }
        }
        lines.push(fsError
            ? `fs-root：读取失败（${fsError}）`
            : `fs-root：${roots.length > 0 ? roots.join("、") : "未配置"}`);
        const writableRoles = new Set(["primary", "core", "workspace"]);
        const missingWritable = paths.filter(([role, path]) => writableRoles.has(role) && !covered(path));
        const missingReadonly = paths.filter(([role, path]) => !writableRoles.has(role) && !covered(path));
        if (missingWritable.length > 0) {
            lines.push("", "需要加入 fs-root 的可写路径：");
            for (const [role, path] of missingWritable)
                lines.push(`- ${role}: ${path}`);
            lines.push("", `修改 ${configPath} 的 mcp.fs-root.command，追加上述路径，然后执行：`, "systemctl restart opencode-serve atme-proxy");
        }
        else {
            lines.push("", "可写路径已覆盖。若仍提示无权限，重启服务并新开消息会话；旧 session 会缓存旧权限。");
        }
        if (missingReadonly.length > 0) {
            lines.push("", "只读路径未在 fs-root 中（不要加入 fs-root，否则会变可写）：");
            for (const [role, path] of missingReadonly)
                lines.push(`- ${role}: ${path}`);
            lines.push("只读读取依赖 atme 的 reference 权限；如果读不到，检查 external_directory 配置。");
        }
        return lines.join("\n");
    }
    async manageWorkspace(arg) {
        const match = arg.trim().match(/^(\S+)\s*([\s\S]*)$/);
        if (!match)
            return "用法：/工作空间 <群名|chatId> [root|添加|删除|自动|清空]";
        const key = match[1] ?? "";
        const rest = (match[2] ?? "").trim();
        const group = this.config.platforms.feishu.groups.find((item) => item.chatId === key || item.name === key);
        if (!group)
            return `找不到群：${key}`;
        if (!rest)
            return this.describeWorkspace(group);
        if (rest === "清空") {
            delete group.workspace;
            await this.persistGroupWorkspace(group);
            await this.ensureGroupWorkspace(group.chatId, group.name, group.project);
            const epoch = await this.groupKnowledge.bumpSessionEpoch(group.chatId);
            return `已清空「${group.name ?? group.chatId}」工作空间配置。${epoch ? `当前会话代际 e${epoch}。` : ""}`;
        }
        const existing = group.workspace ?? { projects: [], docs: [] };
        const workspace = {
            ...(existing.root ? { root: existing.root } : {}),
            projects: [...(existing.projects ?? [])],
            docs: [...(existing.docs ?? [])],
            ...(existing.autoDiscover !== undefined
                ? { autoDiscover: existing.autoDiscover }
                : {}),
        };
        if (rest === "自动" || rest === "auto") {
            workspace.projects = [];
            workspace.autoDiscover = true;
        }
        else if (rest.startsWith("添加 ")) {
            const add = rest.match(/^添加\s+(\S+)\s+(\S+)(?:\s+([\s\S]+))?$/);
            if (!add)
                return "用法：/工作空间 <群名|chatId> 添加 <名称> <路径> [说明]";
            const [, name, path, description] = add;
            workspace.projects = workspace.projects.filter((project) => project.name !== name);
            workspace.projects.push({
                name: name,
                path: path,
                ...(description ? { description } : {}),
                defaultBranch: "HEAD",
                testCommand: [],
                lintCommand: [],
            });
            workspace.autoDiscover = false;
        }
        else if (rest.startsWith("删除 ")) {
            const name = rest.slice("删除 ".length).trim();
            if (!name)
                return "用法：/工作空间 <群名|chatId> 删除 <名称>";
            const before = workspace.projects.length;
            workspace.projects = workspace.projects.filter((project) => project.name !== name);
            if (workspace.projects.length === before)
                return `找不到项目：${name}`;
            workspace.autoDiscover = false;
        }
        else if (rest.startsWith("测试 ") || rest.startsWith("检查 ")) {
            const matchCommand = rest.match(/^(测试|检查)\s+(\S+)\s+([\s\S]+)$/);
            if (!matchCommand) {
                return "用法：/工作空间 <群名|chatId> 测试|检查 <项目名> <命令>";
            }
            const [, kind, name, commandText] = matchCommand;
            const project = workspace.projects.find((item) => item.name === name);
            if (!project)
                return `找不到项目：${name}`;
            const command = commandText.trim().split(/\s+/).filter(Boolean);
            if (command.length === 0)
                return "命令不能为空。";
            if (kind === "测试")
                project.testCommand = [command];
            else
                project.lintCommand = [command];
        }
        else {
            const root = rest.replace(/^设置\s+/, "").trim();
            if (!root)
                return "工作空间根目录不能为空。";
            const groupRoot = this.groupWorkspace.dirFor(group.chatId);
            const resolved = resolve(isAbsolute(root) ? root : join(groupRoot ?? process.cwd(), root));
            const info = await stat(resolved).catch(() => undefined);
            if (!info?.isDirectory())
                return `工作空间目录不存在：${resolved}`;
            workspace.root = resolved;
            workspace.projects = [];
            workspace.autoDiscover = true;
        }
        group.workspace = workspace;
        await this.persistGroupWorkspace(group);
        await this.ensureGroupWorkspace(group.chatId, group.name, group.project, group.workspace);
        const epoch = await this.groupKnowledge.bumpSessionEpoch(group.chatId);
        return `${this.describeWorkspace(group)}${epoch ? `\n会话代际：e${epoch}` : ""}`;
    }
    describeWorkspace(group) {
        const workspace = group.workspace;
        if (!workspace)
            return `「${group.name ?? group.chatId}」还没有配置工作空间。
用法：/工作空间 ${group.name ?? group.chatId} <root>`;
        const provider = this.groupWorkspace.dirFor(group.chatId);
        const lines = [
            `群：${group.name ?? group.chatId}`,
            `工作空间：${workspace.root ?? provider ?? "(未设置)"}`,
        ];
        if ((workspace.projects ?? []).length > 0) {
            lines.push("代码项目：");
            (workspace.projects ?? []).forEach((project, index) => {
                lines.push(`${index + 1}. ${project.name}: ${project.path}${project.description ? `（${project.description}）` : ""}`);
                for (const command of project.lintCommand ?? []) {
                    lines.push(`   lint: ${command.join(" ")}`);
                }
                for (const command of project.testCommand ?? []) {
                    lines.push(`   test: ${command.join(" ")}`);
                }
            });
        }
        else if (workspace.autoDiscover === false) {
            lines.push("代码项目：未配置");
        }
        else {
            lines.push("代码项目：自动发现 worktrees/");
        }
        return lines.join("\n");
    }
    async persistGroupWorkspace(group) {
        const path = this.options.loaded.path;
        if (!path)
            return;
        try {
            const raw = await readJsonFile(path, {});
            const groups = raw.platforms?.feishu?.groups;
            if (Array.isArray(groups)) {
                const target = groups.find((item) => item?.chatId === group.chatId);
                if (target) {
                    if (group.workspace)
                        target.workspace = group.workspace;
                    else
                        delete target.workspace;
                }
            }
            await writeJsonAtomic(path, raw);
        }
        catch (error) {
            this.logger.warn("failed to persist group workspace", {
                chatId: group.chatId,
                error: toErrorMessage(error),
            });
        }
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
    isDmTaskFollowup(message) {
        if (message.chat.kind !== "direct")
            return false;
        return /(刚才|刚刚|继续|接着|补充|上面|前面|之前|那个|这个文档|这个任务|这个需求|这条|文档|任务|pcap|抓包|附件)/i.test(message.text);
    }
    async findActiveDmTask() {
        const notifications = this.taskLinks.recentNotifications(10);
        const cutoff = Date.now() - 24 * 3600_000;
        for (const notification of notifications) {
            if (notification.createdAt < cutoff)
                continue;
            const task = await this.tasks.get(notification.taskId);
            if (!task || task.archivedAt)
                continue;
            if (task.state === "needs_info" && task.source === "group_scan" && !task.lastAnalyzedAt)
                continue;
            if (!["needs_info", "awaiting_approval", "failed", "expired"].includes(task.state))
                continue;
            return task;
        }
        return undefined;
    }
    async handleTaskSupplement(message) {
        if (message.text.trim().startsWith("/"))
            return false;
        if (message.sender.id !== this.ownerOpenId())
            return false;
        if (/(清理|归档|删除|标记完成|完事|已完成|任务完成)/.test(message.text)) {
            return false;
        }
        const replyTo = message.replyToMessageId;
        const activeTask = !replyTo && this.isDmTaskFollowup(message)
            ? await this.findActiveDmTask()
            : undefined;
        if (!replyTo && !activeTask)
            return false;
        const tasks = await this.tasks.list();
        const linkedTaskId = replyTo ? this.taskLinks.findByMessageAny(replyTo) : undefined;
        let task = activeTask ?? (linkedTaskId ? tasks.find((item) => item.id === linkedTaskId && !item.archivedAt) : undefined);
        task ??= tasks.find((item) => !item.archivedAt &&
            (item.messageIds.includes(replyTo) ||
                item.candidateMessageId === replyTo ||
                item.approvalMessageId === replyTo ||
                item.supplements?.some((supplement) => supplement.messageId === replyTo)));
        if (!task && replyTo && this.options.platform.fetchMessage) {
            try {
                const fetched = await this.options.platform.fetchMessage(replyTo);
                const ids = fetched?.text.match(/task_[a-f0-9]{6,}/gi) ?? [];
                for (const id of ids) {
                    const candidate = await this.tasks.get(id);
                    if (candidate && !candidate.archivedAt) {
                        task = candidate;
                        break;
                    }
                }
            }
            catch (error) {
                this.logger.warn("failed to resolve task from replied card", {
                    messageId: replyTo,
                    error: toErrorMessage(error),
                });
            }
        }
        if (!task)
            return false;
        const state = await this.taskService.appendSupplement(task, message);
        await this.markProcessed(message);
        if (state === "awaiting_approval" || state === "needs_info") {
            this.pending.deleteForTask(task.id);
            await this.pending.flush();
            task.state = "analyzing";
            task.updatedAt = Date.now();
            await this.tasks.save(task);
            this.track(this.analyzeTask(task)).catch((error) => {
                this.logger.error("supplement analysis failed", {
                    taskId: task.id,
                    error: toErrorMessage(error),
                });
            });
            await this.sendToOwner(`已收到补充，正在重新分析：${task.title}`);
        }
        else if (state === "executing") {
            await this.sendToOwner(`已记录补充；当前执行不会中途改变：${task.title}`);
        }
        else {
            await this.sendToOwner(`已收到补充：${task.title}`);
        }
        return true;
    }
    async withPermissionGuidance(message, reply) {
        if (message.chat.kind !== "direct")
            return reply;
        if (reply.includes("/诊断"))
            return reply;
        if (!/(无权限|没有权限|无访问权限|不在.{0,12}可读范围|允许目录|permission\s+denied|access\s+denied|not\s+authorized|outside.{0,20}allowed|cannot\s+read|could\s+not\s+read|无法读取|不能读取|无法访问)/i.test(reply)) {
            return reply;
        }
        const ownerId = this.ownerOpenId();
        const target = ownerId ? this.ownerTargets.get(ownerId) : undefined;
        const group = target
            ? this.config.platforms.feishu.groups.find((item) => item.chatId === target.chatId || item.name === target.chatName)
            : undefined;
        const diagnostic = group
            ? await this.diagnoseProject(group.name ?? group.chatId)
            : "未找到当前关联群。请发送：/诊断 <群名|chatId>";
        return `${reply}\n\n————\n看起来是权限或目录未放行，自动诊断如下：\n${diagnostic}`;
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
        if (await this.handleTaskSupplement(message)) {
            this.activeMessageIds.delete(dedupKey);
            return;
        }
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
        const groupLookupReply = await this.handleGroupLookupIntent(message);
        if (groupLookupReply) {
            await this.safeReply(message, groupLookupReply);
            await this.markProcessed(message);
            this.activeMessageIds.delete(dedupKey);
            return;
        }
        const permissionReply = await this.handlePermissionReply(message);
        if (permissionReply) {
            await this.safeReply(message, permissionReply);
            await this.markProcessed(message);
            this.activeMessageIds.delete(dedupKey);
            return;
        }
        const cancelReply = await this.handleTaskCancelIntent(message);
        if (cancelReply) {
            await this.safeReply(message, cancelReply);
            await this.markProcessed(message);
            this.activeMessageIds.delete(dedupKey);
            return;
        }
        const purgeReply = await this.handleTaskPurgeIntent(message);
        if (purgeReply) {
            await this.safeReply(message, purgeReply);
            await this.markProcessed(message);
            this.activeMessageIds.delete(dedupKey);
            return;
        }
        const taskAdminReply = await this.handleTaskAdminIntent(message.text);
        if (taskAdminReply) {
            await this.safeReply(message, taskAdminReply);
            await this.markProcessed(message);
            this.activeMessageIds.delete(dedupKey);
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
                conversationId: this.conversationIdFor(message.platform, message.chat.id, message.chat.kind === "direct" ? "dm" : "group"),
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
                    const finalReply = await this.withPermissionGuidance(message, this.sanitize(reply));
                    const ok = await this.safeReply(message, finalReply);
                    if (ok) {
                        await this.markProcessed(message);
                        void this.updateDmSummary(message.platform, message.chat.id).catch((error) => {
                            this.logger.warn("dm summary update failed", {
                                chatId: message.chat.id,
                                error: toErrorMessage(error),
                            });
                        });
                    }
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
    isFileRelevant(message, fileName, content) {
        const profile = this.groupKnowledge.get(message.chat.id);
        const responsibility = this.config.platforms.feishu.groups.find((group) => group.chatId === message.chat.id)?.responsibility;
        const terms = [
            profile?.product ?? "",
            ...(profile?.features ?? []),
            ...(profile?.dependsOn ?? []),
            ...(responsibility?.summary ? [responsibility.summary] : []),
            ...(responsibility?.owns ?? []),
        ]
            .flatMap((value) => value.split(/[\s,，。；;、:：/]+/))
            .map((value) => value.trim().toLowerCase())
            .filter((value) => value.length >= 2);
        if (terms.length === 0)
            return undefined;
        const haystack = `${fileName}\n${content ?? ""}`.toLowerCase();
        return terms.some((term) => haystack.includes(term));
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
        const labels = await this.describeTask(task);
        const project = await this.resolveProject(task.chatId);
        const sourceLink = task.messageLink ?? (await this.resolveMessageLink(task.messageIds[0]));
        const selectedProjects = (project.workspaceProjects ?? []).filter((item) => analysis.repos.includes(item.name));
        const projectLabel = project.resolved
            ? project.workspace
                ? selectedProjects.map((item) => item.name).join("、") ||
                    (project.workspaceProjects ?? []).map((item) => item.name).join("、") ||
                    basename(project.worktree).replace(/\.git$/, "")
                : basename(project.worktree).replace(/\.git$/, "")
            : "未配置";
        const planLines = analysis.plan.map((step) => step.detail ? `${step.step}：${step.detail}` : step.step);
        const view = {
            taskId: task.id,
            planHash: analysis.planHash,
            mode: "develop",
            title: task.title,
            summary: `【${labels.chatLabel}】${truncate(task.excerpt, 200)}`,
            chatLabel: labels.chatLabel,
            ...(sourceLink ? { sourceLink: { label: "打开原消息", url: sourceLink } } : {}),
            repo: repo?.id ?? projectLabel,
            baseBranch: repo?.defaultBranch ?? (project.resolved ? "当前工作区" : "main"),
            targetBranch: repo || project.workspace || (project.writableProjects?.length ?? 0) > 0
                ? `atme/${task.id}`
                : "不创建分支",
            scope: analysis.scope,
            files: analysis.files,
            plan: planLines,
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
        if (result.messageId) {
            task.approvalMessageId = result.messageId;
            await this.tasks.save(task);
            await this.taskLinks.linkMessage(task.chatId, result.messageId, task.id);
            await this.taskLinks.recordNotification({
                taskId: task.id,
                chatId: task.chatId,
                kind: "approval",
                title: `待审批 · ${labels.chatLabel}`,
                summary: truncate(task.title, 160),
                cardMessageId: result.messageId,
                ...(task.messageIds[0] ? { sourceMessageId: task.messageIds[0] } : {}),
                ...(sourceLink ? { sourceUrl: sourceLink } : {}),
            });
        }
        this.pending.set(`${task.id}:develop`, {
            platform: task.platform,
            taskId: task.id,
            analysisVersion: analysis.version,
            planHash: analysis.planHash,
            actorId: target.userId,
            mode: "develop",
            ...(result.messageId ? { messageId: result.messageId } : {}),
            chatId: task.chatId,
            view,
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
        if (!group?.project || (group.project.primary?.length ?? 0) > 0)
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
    async onAction(action) {
        if (action.action === "permission_allow" || action.action === "permission_deny") {
            if (action.actor.id !== this.ownerOpenId())
                return { ok: false, toast: "无权操作" };
            const allow = action.action === "permission_allow";
            const view = this.permissionBridge.requestView(action.taskId);
            const result = await this.permissionBridge.reply(action.taskId, allow ? "once" : "reject");
            const card = view
                ? this.options.platform.renderPermissionRequest?.({
                    ...view,
                    resolution: allow ? "allow" : "deny",
                })
                : undefined;
            return { ok: true, toast: result, ...(card?.kind === "card" ? { card: card.card } : {}) };
        }
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
        return this.sessionManager.createGroupSession(platform, chatId, directory, this.conversationIdFor(platform, chatId, "group"));
    }
    async updateDmSummary(platform, chatId) {
        if (this.config.groupSession?.enabled === false)
            return;
        const every = this.config.groupSession?.summaryEveryMessages ?? 8;
        const maxChars = this.config.groupSession?.summaryMaxChars ?? 1500;
        const timeoutMs = this.config.groupSession?.timeoutMs ?? 30_000;
        const key = `${platform}:${chatId}`;
        const current = this.dmContext.get(chatId);
        const since = current?.lastMessageAt ?? 0;
        const messages = this.chatContext.recent(key, 50).filter((item) => item.at > since);
        if (messages.length < every)
            return;
        const directory = (await this.resolveProject(chatId)).worktree;
        const sessionId = await this.sessionManager.createGroupSession(platform, chatId, directory, this.conversationIdFor(platform, chatId, "dm"), `${this.config.opencode.sessionTitlePrefix}:dm-summary:${chatId}`);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error("dm summary timed out")), timeoutMs);
        let raw;
        try {
            raw = await this.options.bridge.prompt(sessionId, {
                directory,
                title: `${this.config.opencode.sessionTitlePrefix}:dm-summary:${chatId}`,
                text: [
                    "你是 owner 私聊记录员。只维护私聊长期上下文，不回答问题、不执行操作。",
                    "保留：owner 的偏好、已确认决策、进行中的目标、未解决问题、关键约束。",
                    "不要记录一次性寒暄、临时闲聊、密码/密钥等敏感信息。",
                    `合并现有上下文和新消息；去掉重复；摘要不超过 ${maxChars} 字。`,
                    '输出严格 JSON：{summary, preferences, decisions, ongoing_goals, open_questions}。',
                    "现有上下文：",
                    JSON.stringify(current ?? {}),
                    "新增消息：",
                    ...messages.map((item) => `- ${item.senderName ?? item.senderId}: ${truncateMiddle(item.text, 500)}`),
                ].join("\n"),
                signal: controller.signal,
            });
        }
        finally {
            clearTimeout(timer);
        }
        const parsed = parseJsonLoose(raw);
        const summary = typeof parsed?.summary === "string" ? parsed.summary.trim() : raw.trim();
        const preferences = stringArray(parsed?.preferences);
        const decisions = stringArray(parsed?.decisions);
        const ongoingGoals = stringArray(parsed?.ongoing_goals);
        const openQuestions = stringArray(parsed?.open_questions);
        const semanticChanged = Boolean(current &&
            (JSON.stringify(current.preferences) !== JSON.stringify(preferences) ||
                JSON.stringify(current.decisions) !== JSON.stringify(decisions)));
        const now = Date.now();
        this.dmContext.set({
            chatId,
            summary: truncateMiddle(summary, maxChars),
            preferences,
            decisions,
            ongoingGoals,
            openQuestions,
            lastMessageAt: messages[messages.length - 1]?.at ?? now,
            updatedAt: now,
            sessionEpoch: (current?.sessionEpoch ?? 1) + (semanticChanged ? 1 : 0),
        });
        await this.dmContext.flush();
        await this.audit.append({
            actor: { system: true },
            action: "dm_summary_updated",
            details: { chatId, messages: messages.length },
        });
    }
    async updateGroupSummary(platform, chatId) {
        if (this.config.groupSession?.enabled === false)
            return;
        const key = `${platform}:${chatId}`;
        const retryAfter = this.groupSummaryFailureUntil.get(key) ?? 0;
        if (retryAfter > Date.now())
            return;
        const previous = this.groupLocks.get(key) ?? Promise.resolve();
        const next = previous
            .then(async () => {
            await this.doUpdateGroupSummary(platform, chatId);
            this.groupSummaryFailureUntil.delete(key);
        })
            .catch((error) => {
            this.groupSummaryFailureUntil.set(key, Date.now() + 5 * 60_000);
            this.logger.warn("group summary update failed; backing off", {
                chatId,
                retryAfterSeconds: 300,
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
        const minChars = this.config.groupSession?.summaryMinNewChars ?? 1200;
        const maxAgeMinutes = this.config.groupSession?.summaryMaxAgeMinutes ?? 120;
        const maxChars = this.config.groupSession?.summaryMaxChars ?? 1500;
        const timeoutMs = this.config.groupSession?.timeoutMs ?? 30_000;
        const key = `${platform}:${chatId}`;
        const current = this.groupContext.get(key);
        const since = current?.lastMessageAt ?? 0;
        const group = this.config.platforms.feishu.groups.find((item) => item.chatId === chatId);
        const focus = group?.ownerFocus;
        const profile = this.groupKnowledge.get(chatId);
        const ownProjects = [
            ...new Set([
                ...(group?.project?.primary ?? []),
                ...(group?.project?.core ?? []),
                ...(group?.workspace?.projects ?? []).map((item) => item.name),
            ]),
        ];
        const messages = this.chatContext
            .recent(key, 50)
            .filter((item) => item.at > since)
            .filter((item) => {
            const prefilter = prefilterMessage({
                platform,
                messageId: item.messageId,
                chat: { id: chatId, kind: "group" },
                sender: { platform, id: item.senderId },
                senderType: "user",
                text: item.text,
                mentions: [],
                createdAt: item.at,
                rawType: "text",
            }, {
                ...(group ? { coreProjects: [...(group.project?.primary ?? []), ...(group.project?.core ?? [])] } : {}),
                ...(focus?.keywords ? { ownerKeywords: focus.keywords } : {}),
                ...(focus?.summary ? { ownerDirection: focus.summary } : {}),
            });
            return !prefilter.strongExternal;
        });
        if (messages.length < every)
            return;
        const chars = messages.reduce((sum, item) => sum + item.text.length, 0);
        const uniqueRatio = new Set(messages.map((item) => item.text.replace(/\s+/g, ""))).size /
            Math.max(1, messages.length);
        const hasSignal = messages.some((item) => /(决定|结论|确认|方案|风险|问题|任务|待办|接口|字段|表名|排期|上线)/.test(item.text));
        const oldest = messages[0];
        if (!oldest)
            return;
        const ageMinutes = (Date.now() - oldest.at) / 60_000;
        if (chars < minChars && uniqueRatio < 0.5 && !hasSignal && ageMinutes < maxAgeMinutes) {
            this.logger.debug("group summary skipped; low information density", {
                chatId,
                messages: messages.length,
                chars,
                uniqueRatio,
                ageMinutes,
            });
            return;
        }
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
                    "只记录与 owner_direction/own_projects 相关的内容；平台资产台账、管理平台、前端页面、联调发布、性能压测/CPU/内存/IO 指标，与核心引擎或 transform 无关时不要写入摘要或 topics。",
                    "旧摘要里如果包含上述无关内容，直接删除，不要保留。",
                    "保留：已确认决策、被否决方案及原因、当前假设、未解决问题、关键表名/接口/字段。",
                    `owner_direction：${focus?.summary || profile?.ownerDirection || "（未配置）"}`,
                    `own_projects：${ownProjects.join("、") || "（未配置）"}`,
                    "同时识别当前群的讨论主题、阶段性任务和阶段：topics = [{title, summary, phase, status, message_ids}]。",
                    "status 只能是 active/paused/done；phase 是当前阶段，例如需求确认、排查、开发、验证、发布。",
                    "只处理新增消息；不要重复已经摘要过的事实；旧摘要只用于保持连续。",
                    `在旧摘要基础上更新，不要把旧事实重新逐条复述；不超过 ${maxChars} 字。`,
                    '输出严格 JSON：{summary, decisions, assumptions, open_questions, topics}。',
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
        const topics = Array.isArray(parsed?.topics)
            ? parsed.topics
                .filter((item) => item && typeof item === "object")
                .slice(0, 8)
                .map((item) => ({
                title: typeof item.title === "string" ? item.title.trim() : "",
                ...(typeof item.summary === "string" && item.summary.trim()
                    ? { summary: item.summary.trim() }
                    : {}),
                ...(typeof item.phase === "string" && item.phase.trim()
                    ? { phase: item.phase.trim() }
                    : {}),
                status: item.status === "paused" || item.status === "done" ? item.status : "active",
                ...(Array.isArray(item.message_ids)
                    ? {
                        messageIds: item.message_ids.filter((id) => typeof id === "string"),
                    }
                    : {}),
            }))
                .filter((item) => item.title)
            : current?.topics;
        const record = {
            chatId: key,
            conversationId: this.conversationIdFor(platform, chatId, "group"),
            summary: truncateMiddle(summaryText.trim(), maxChars),
            decisions: stringArray(parsed?.decisions),
            assumptions: stringArray(parsed?.assumptions),
            openQuestions: stringArray(parsed?.open_questions),
            ...(topics ? { topics } : {}),
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
    async discoverWorkspaceProjects(root) {
        const roots = [join(root, "worktrees"), root];
        for (const dir of roots) {
            try {
                const entries = await readdir(dir, { withFileTypes: true });
                const projects = entries
                    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
                    .map((entry) => ({ name: entry.name, path: join(dir, entry.name) }))
                    .sort((a, b) => a.name.localeCompare(b.name));
                if (projects.length > 0)
                    return projects;
            }
            catch {
                continue;
            }
        }
        return [];
    }
    async discoverWorkspaceDocs(root) {
        const docs = [];
        for (const dir of [join(root, "docs")]) {
            try {
                const entries = await readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (!entry.isFile() || entry.name.startsWith("."))
                        continue;
                    if (!/\.(md|markdown|txt|pdf|docx|doc|html?|xlsx?|csv|json|ya?ml)$/i.test(entry.name)) {
                        continue;
                    }
                    docs.push(join(dir, entry.name));
                    if (docs.length >= 30)
                        return docs.sort();
                }
            }
            catch {
                continue;
            }
        }
        return docs.sort();
    }
    async resolveProject(chatId) {
        const groupConfig = this.config.platforms.feishu.groups.find((group) => group.chatId === chatId);
        const workspaceConfig = groupConfig?.workspace;
        if (workspaceConfig) {
            const groupRoot = this.groupWorkspace.dirFor(chatId) ??
                (this.config.project.worktree ?? join(this.stateDir, "scratch"));
            const configuredRoot = workspaceConfig.root?.trim();
            const root = configuredRoot
                ? resolve(isAbsolute(configuredRoot) ? configuredRoot : join(groupRoot, configuredRoot))
                : groupRoot;
            const configuredProjects = workspaceConfig.projects ?? [];
            const autoDiscover = workspaceConfig.autoDiscover ?? configuredProjects.length === 0;
            const projects = configuredProjects.length > 0
                ? configuredProjects.map((project) => ({
                    name: project.name,
                    path: resolve(isAbsolute(project.path) ? project.path : join(root, project.path)),
                    ...(project.description ? { description: project.description } : {}),
                    defaultBranch: project.defaultBranch,
                    testCommand: project.testCommand,
                    lintCommand: project.lintCommand,
                }))
                : autoDiscover
                    ? await this.discoverWorkspaceProjects(root)
                    : [];
            const configuredDocs = workspaceConfig.docs ?? [];
            const docs = configuredDocs.length > 0
                ? configuredDocs.map((doc) => resolve(isAbsolute(doc) ? doc : join(root, doc)))
                : await this.discoverWorkspaceDocs(root);
            return {
                worktree: root,
                workspace: true,
                workspaceRoot: root,
                workspaceProjects: projects,
                workspaceDocs: docs,
                coreProjects: projects.map((project) => project.path),
                writableProjects: projects.map((project) => project.path),
                resolved: true,
                reason: "group workspace config",
            };
        }
        const groupProject = groupConfig?.project;
        if (groupProject) {
            const primary = groupProject.primary ?? [];
            if (primary.length === 0) {
                void this.notifyMissingProject(chatId);
                return {
                    worktree: this.config.project.worktree ?? join(this.stateDir, "scratch"),
                    secondaryWorktrees: [...(groupProject.reference ?? []), ...(groupProject.secondary ?? [])],
                    coreProjects: groupProject.core ?? [],
                    writableProjects: groupProject.core ?? [],
                    referenceProjects: [...(groupProject.reference ?? []), ...(groupProject.secondary ?? [])],
                    resolved: false,
                    reason: "group project not configured",
                };
            }
            return {
                worktree: primary[0],
                secondaryWorktrees: [...(groupProject.reference ?? []), ...(groupProject.secondary ?? [])],
                coreProjects: [...primary.slice(1), ...(groupProject.core ?? [])],
                writableProjects: [...primary, ...(groupProject.core ?? [])],
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
function inferFeatures(product) {
    if (/资产测绘/.test(product)) {
        return ["资产管理", "探测任务", "资产发现", "指纹", "弱口令", "漏洞", "POC"];
    }
    if (/流分/.test(product)) {
        return ["协议解析", "会话缓存", "流分变换", "网络访问行为", "Kafka", "KD-ZMQ"];
    }
    return [];
}
function inferTerms(product) {
    if (/资产测绘/.test(product)) {
        return {
            资产测绘: "本群产品，围绕资产发现、识别与风险管理，不是通用地图测绘",
            指纹: "资产指纹识别（协议/组件/版本），不是浏览器 fingerprint",
            探测任务: "资产测绘发起的扫描/探测作业，不是通用定时任务",
            引擎: "npb-engine，负责流量采集与协议解析",
            流分: "npb-transform 流分装置，不是资产测绘模块",
        };
    }
    if (/流分/.test(product)) {
        return {
            流分: "npb-transform 流分装置，负责流变换与分发",
            引擎: "npb-engine，负责流量采集与协议解析",
            资产测绘: "另一个产品群，不要把资产测绘需求混入本群",
        };
    }
    return {};
}
//# sourceMappingURL=runtime.js.map