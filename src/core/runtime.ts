import { join } from "node:path";
import type {
  AnalysisVerification,
  BotIntent,
  Classification,
  ExecutionRecord,
  IncomingMessage,
  PlatformAction,
  PlatformActionResult,
  TaskAnalysis,
  TaskRecord,
} from "./types.js";
import type { ChatMembershipEvent, PlatformAdapter } from "./ports.js";
import type { AppConfig, LoadedConfig, RepoConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { createLogger } from "./logger.js";
import type { OpenCodeBridge } from "./opencode.js";
import { repoById } from "./opencode.js";
import type { LlmClient, Profile } from "./relevance.js";
import {
  OpenAiCompatibleClient,
  RelevanceService,
  makeDedupKey,
  parseJsonLoose,
  type KeywordRule,
} from "./relevance.js";
import type { ReplyStyle, ReplyStyleOptions } from "./reply-style.js";
import {
  buildStyleInstruction,
  detectReplyDepth,
  detectReplyStyle,
  enforceReplyLength,
  type ReplyDepth,
} from "./reply-style.js";
import { DedupStore } from "./dedup.js";
import { CursorStore } from "./cursor.js";
import { SessionStore } from "./session-store.js";
import { TaskStore } from "./task-store.js";
import { ApprovalStore } from "./approval-store.js";
import { AuditLog } from "./audit.js";
import { ConcurrentDispatcher } from "./dispatcher.js";
import { PollingService } from "./poller.js";
import type { PendingCard } from "./pending-store.js";
import { PendingStore } from "./pending-store.js";
import { Semaphore, TokenBucket } from "./rate-limit.js";
import { GitExecutor } from "./executor.js";
import { ProjectResolver, candidateLogFields } from "./project-resolver.js";
import { OpenCodeLlmClient } from "./opencode-llm.js";
import { selectBurstExtensions, mergeBurst } from "./burst.js";
import { ProjectStore } from "./project-store.js";
import { ChatContextStore } from "./chat-context.js";
import { EvidenceStore } from "./evidence-store.js";
import { GroupContextStore, type GroupSummary } from "./group-context.js";
import { MemoryStore, type MemoryKind } from "./memory-store.js";
import { SenderLimiter } from "./sender-limiter.js";
import { SessionManager, type ChildInput, type WorkerInput } from "./session-manager.js";
import { ContextService, type AnalysisContext } from "./context-service.js";
import { ApprovalService } from "./approval-service.js";
import { ExecutionService } from "./execution-service.js";
import { OwnerCommandService } from "./owner-command-service.js";
import { ReplyService } from "./reply-service.js";
import { TaskService } from "./task-service.js";
import { IntentService } from "./intent-service.js";
import { MessageIngress } from "./message-ingress.js";
import { MeMentionFlow } from "./me-mention-flow.js";
import { BotMentionFlow } from "./bot-mention-flow.js";
import { parseAnalysis } from "./analysis.js";
import { buildAnalysisPrompt } from "./prompts.js";
import { parseOwnerCommand, type OwnerCommand } from "./owner-command.js";
import {
  deterministicVerification,
  mergeVerification,
  parseVerification,
} from "./analysis-verify.js";
import { OwnerStore, type OwnerBinding } from "./owner-store.js";
import { canTransition } from "./task-state.js";
import {
  readJsonFile,
  formatLocalTime,
  sha256,
  stableUuid,
  toErrorMessage,
  redactPreview,
  truncate,
  truncateMiddle,
  writeJsonAtomic,
} from "./util.js";

const ASSISTANT_LABEL = "（助手代答）";

const READ_ONLY_PERMISSION: Array<{
  permission: string;
  pattern: string;
  action: "allow" | "deny" | "ask";
}> = [
  { permission: "edit", pattern: "*", action: "deny" },
  { permission: "bash", pattern: "*", action: "deny" },
  { permission: "webfetch", pattern: "*", action: "deny" },
  { permission: "websearch", pattern: "*", action: "deny" },
  { permission: "external_directory", pattern: "*", action: "deny" },
];

const EXECUTION_PERMISSION: typeof READ_ONLY_PERMISSION = [
  { permission: "webfetch", pattern: "*", action: "deny" },
  { permission: "websearch", pattern: "*", action: "deny" },
  { permission: "external_directory", pattern: "*", action: "deny" },
];

export interface RuntimeOptions {
  platform: PlatformAdapter;
  bridge: OpenCodeBridge;
  loaded: LoadedConfig;
  logger?: Logger;
  llm?: LlmClient;
}

export class ProxyRuntime {
  private readonly logger: Logger;
  private readonly config: AppConfig;
  private readonly stateDir: string;
  private readonly dedup: DedupStore;
  private readonly outbound: DedupStore;
  private readonly cursors: CursorStore;
  private readonly sessions: SessionStore;
  private readonly sessionManager: SessionManager;
  private readonly chatNames = new Map<string, { name: string; at: number }>();
  private readonly recentMessages = new Map<string, IncomingMessage[]>();
  private readonly tasks: TaskStore;
  private readonly approvals: ApprovalStore;
  private readonly audit: AuditLog;
  private readonly dispatcher: ConcurrentDispatcher;
  private readonly sendLimiter: TokenBucket;
  private readonly relevance: RelevanceService;
  private readonly llm: LlmClient;
  private readonly replyOptions: ReplyStyleOptions;
  private readonly activeMessageIds = new Set<string>();
  private readonly pending: PendingStore;
  private readonly poller: PollingService;
  private readonly executor: GitExecutor;
  private started = false;
  private readonly groupIds: Set<string>;
  private readonly pollingEnabled: boolean;
  private readonly filterEnabled: boolean;
  private readonly projectStore: ProjectStore;
  private readonly chatContext: ChatContextStore;
  private readonly evidence: EvidenceStore;
  private readonly groupContext: GroupContextStore;
  private readonly contextService: ContextService;
  private readonly approvalService: ApprovalService;
  private readonly executionService: ExecutionService;
  private readonly ownerCommandService: OwnerCommandService;
  private readonly replyService: ReplyService;
  private readonly taskService: TaskService;
  private readonly intentService: IntentService;
  private readonly messageIngress: MessageIngress;
  private readonly meMentionFlow: MeMentionFlow;
  private readonly botMentionFlow: BotMentionFlow;
  private readonly groupLocks = new Map<string, Promise<void>>();
  private readonly memory: MemoryStore;
  private readonly owners: OwnerStore;
  private resolvedOwner?: OwnerBinding;
  private readonly claimAttempts = new Map<string, { count: number; firstAt: number }>();
  private readonly senderLimiter: SenderLimiter;
  private projectResolver?: ProjectResolver;
  private readonly background = new Set<Promise<unknown>>();
  private readonly projectCache = new Map<
    string,
    { worktree: string; projectId?: string; resolved: boolean; reason: string; at: number }
  >();

  constructor(private readonly options: RuntimeOptions) {
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
    this.sessions = new SessionStore(
      join(this.stateDir, "sessions.json"),
      this.logger.child("sessions"),
    );
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
    this.pending = new PendingStore(
      join(this.stateDir, "pending.json"),
      this.logger.child("pending"),
    );
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
    this.projectStore = new ProjectStore(
      join(this.stateDir, "projects.json"),
      this.logger.child("projects"),
    );
    this.senderLimiter = new SenderLimiter({
      maxPerMinute: this.config.botReply.perSenderPerMinute,
      maxConcurrent: this.config.botReply.perSenderConcurrent,
      cooldownMs: this.config.botReply.cooldownSeconds * 1000,
    });
    this.owners = new OwnerStore(
      join(this.stateDir, "owner.json"),
      this.logger.child("owner"),
    );
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
    this.groupContext = new GroupContextStore(
      join(this.stateDir, "group-context.json"),
      this.logger.child("group-context"),
    );
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
    this.sendLimiter = new TokenBucket(
      this.config.platforms.feishu.rateLimit.sendPerSecond,
      this.config.platforms.feishu.rateLimit.burst,
    );
    this.groupIds = new Set(
      this.config.platforms.feishu.groups
        .filter((group) => group.enabled)
        .map((group) => group.chatId),
    );
    this.messageIngress = new MessageIngress({
      config: this.config,
      logger: this.logger.child("ingress"),
      dedup: this.dedup,
      chatContext: this.chatContext,
      evidence: this.evidence,
      senderLimiter: this.senderLimiter,
      activeMessageIds: this.activeMessageIds,
      ownerOpenId: () => this.ownerOpenId(),
      botOpenId: () =>
        (this.options.platform as { getBotOpenId?: () => string | undefined }).getBotOpenId?.() ??
        this.config.platforms.feishu.botOpenId,
      rememberRecent: (message) => this.rememberRecent(message),
      updateGroupSummary: (platform, chatId) => {
        void this.updateGroupSummary(platform, chatId);
      },
      safeReply: (message, text) => this.safeReply(message, text),
      dispatch: (message, limited, wait) =>
        this.dispatchGroupMessage(message, limited, wait),
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
      askOpenCode: (message, style, signal) =>
        this.askOpenCode(message, style, signal),
      approveReply: (action, pending) => this.approveReply(action, pending),
      logger: this.logger.child("owner-command"),
    });
    const profile: Profile = {
      name: this.config.filter.profile.name,
      role: this.config.filter.profile.role,
      keywords: this.config.filter.profile.keywords,
      projects: this.config.filter.profile.projects,
      tasks: this.config.filter.profile.tasks,
    };
    const keywords: KeywordRule = {
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
    this.taskService = new TaskService({
      config: this.config,
      stateDir: this.stateDir,
      tasks: this.tasks,
      audit: this.audit,
      contextService: this.contextService,
      sessionManager: this.sessionManager,
      logger: this.logger.child("task"),
      readOnlyPermission: READ_ONLY_PERMISSION,
      resolveProject: async (chatId) => {
        const project = await this.resolveProject(chatId);
        return { worktree: project.worktree, resolved: project.resolved };
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
        const burst = await this.applyBurstGrouping(message, signal);
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
      sendToOwner: (text) => this.sendToOwner(text),
      sendToApprover: (text) => this.sendToApprover(text),
      safeReply: (message, text) => this.safeReply(message, text),
      markProcessed: (message) => this.markProcessed(message),
      rememberFromMention: (message, intent, analysis) =>
        this.rememberFromMention(message, intent, analysis),
    });
  }

  private initOwner(): void {
    const feishu = this.config.platforms.feishu;
    const openId = feishu.me.openId ?? feishu.approvers[0]?.openId;
    if (!openId) return;
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

  private reconcileOwner(): void {
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

  private ownerOpenId(): string | undefined {
    return this.resolvedOwner?.openId ?? this.config.platforms.feishu.me.openId ?? this.config.platforms.feishu.approvers[0]?.openId;
  }

  private ownerName(): string {
    return (
      this.resolvedOwner?.displayName ??
      this.config.platforms.feishu.me.name ??
      this.config.filter.profile.name ??
      "我"
    );
  }

  private async claimOwner(message: IncomingMessage): Promise<boolean> {
    const bootstrap = this.config.platforms.feishu.bootstrap;
    if (!bootstrap.allowPrivateClaim) return false;
    const claimCode = this.options.loaded.secrets.claimCode;
    if (!claimCode) return false;
    if (message.chat.kind !== "direct") return false;

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

    const binding: OwnerBinding = {
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
    await this.sendToOwner(
      `已绑定你为 owner：${message.sender.displayName ?? message.sender.id}。后续 @、升级、审批都发给你。`,
    );
    return true;
  }

  private recordClaimAttempt(senderId: string): void {
    const now = Date.now();
    const entry = this.claimAttempts.get(senderId);
    if (!entry || now - entry.firstAt > 600_000) {
      this.claimAttempts.set(senderId, { count: 1, firstAt: now });
      return;
    }
    entry.count += 1;
  }

  private tooManyClaimAttempts(senderId: string): boolean {
    const entry = this.claimAttempts.get(senderId);
    if (!entry) return false;
    if (Date.now() - entry.firstAt > 600_000) {
      this.claimAttempts.delete(senderId);
      return false;
    }
    return entry.count > this.config.platforms.feishu.bootstrap.maxClaimAttemptsPer10Min;
  }

  private async sendToOwner(text: string): Promise<boolean> {
    const openId = this.ownerOpenId();
    if (!openId) return false;
    try {
      await this.sendLimiter.take();
      await this.options.platform.send(
        { kind: "user", userId: openId },
        { kind: "text", text, uuid: stableUuid("owner", openId, sha256(text).slice(0, 16)) },
      );
      return true;
    } catch (error) {
      this.logger.error("failed to send to owner", { error: toErrorMessage(error) });
      return false;
    }
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.background.add(promise);
    promise.finally(() => this.background.delete(promise)).catch(() => {});
    return promise;
  }

  private async drainBackground(timeoutMs = 5000): Promise<void> {
    if (this.background.size === 0) return;
    const pending = Promise.allSettled([...this.background]);
    await Promise.race([
      pending,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  private sweepTimer?: NodeJS.Timeout;

  async start(): Promise<void> {
    if (this.started) return;
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

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
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

  private async onMessage(message: IncomingMessage, wait = false): Promise<void> {
    if (message.senderType !== "user") return;
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
    await this.messageIngress.handle(message, chatName, wait);
  }

  private async dispatchGroupMessage(
    message: IncomingMessage,
    limited: boolean,
    wait: boolean,
  ): Promise<void> {
    const dedupKey = `${message.platform}:${message.messageId}`;
    const mention = this.isMention(message);
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
        } finally {
          this.activeMessageIds.delete(dedupKey);
          if (limited) this.senderLimiter.release(message.sender.id);
        }
      },
    });
    if (wait) {
      try {
        await job;
      } catch (error) {
        this.activeMessageIds.delete(dedupKey);
        if (limited) this.senderLimiter.release(message.sender.id);
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
      if (limited) this.senderLimiter.release(message.sender.id);
      this.logger.error("failed to process message", {
        messageId: message.messageId,
        error: toErrorMessage(error),
      });
    });
  }

  async ingest(message: IncomingMessage): Promise<void> {
    await this.onMessage(message, true);
  }

  async ingestBatch(messages: IncomingMessage[]): Promise<void> {
    await this.handlePolledBatch(messages);
  }

  private isMention(message: IncomingMessage): boolean {
    const me = this.ownerOpenId();
    const bot = this.options.platform.platform === "feishu"
      ? (this.options.platform as { getBotOpenId?: () => string | undefined }).getBotOpenId?.() ??
        this.config.platforms.feishu.botOpenId
      : this.config.platforms.feishu.botOpenId;
    return message.mentions.some((mention) => mention.id === me || (bot && mention.id === bot));
  }

  private isMentionMe(message: IncomingMessage): boolean {
    const me = this.ownerOpenId();
    return Boolean(me) && message.mentions.some((mention) => mention.id === me);
  }

  private isMentionBot(message: IncomingMessage): boolean {
    const bot = (this.options.platform as { getBotOpenId?: () => string | undefined })
      .getBotOpenId?.() ?? this.config.platforms.feishu.botOpenId;
    return Boolean(bot) && message.mentions.some((mention) => mention.id === bot);
  }

  private async onChatMembership(event: ChatMembershipEvent): Promise<void> {
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
    await this.sendToOwner(
      `机器人已被加入群：${name}\nchat_id：${event.chatId}\n已自动加入处理白名单；重启后仍生效需写入配置（atme-proxy chats --sync）。`,
    );
    await this.audit.append({
      actor: { system: true },
      action: "bot_added_to_chat",
      details: { chatId: event.chatId, chatName: name, actorId: event.actorId },
    });
  }

  private async fetchChatName(chatId: string): Promise<string | undefined> {
    const client = this.options.bridge.getClient?.();
    if (!client) return undefined;
    try {
      const response: any = await (client as any).im.v1.chat.get({
        path: { chat_id: chatId },
      });
      if (typeof response?.data?.name === "string" && response.data.name) {
        return response.data.name;
      }
    } catch (error) {
      this.logger.debug("chat.get failed; trying raw request", {
        chatId,
        error: toErrorMessage(error),
      });
    }
    try {
      const raw: any = await (client as any).request({
        method: "GET",
        url: `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`,
      });
      if (typeof raw?.data?.name === "string" && raw.data.name) return raw.data.name;
    } catch (error) {
      this.logger.debug("raw chat lookup failed", {
        chatId,
        error: toErrorMessage(error),
      });
    }
    return undefined;
  }

  private async chatLabel(message: IncomingMessage): Promise<string> {
    const chatId = message.chat.id;
    const cached = this.chatNames.get(chatId);
    if (cached && Date.now() - cached.at < 6 * 3600_000) return cached.name;
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

  private handleOwnerCommand(
    message: IncomingMessage,
    command: OwnerCommand,
  ): Promise<string> {
    return this.ownerCommandService.handle(message, command);
  }

  private async handleDirectMessage(message: IncomingMessage): Promise<void> {
    if (!this.config.directChat.enabled) return;
    const ownerId = this.ownerOpenId();
    if (this.config.directChat.onlyOwner && ownerId && message.sender.id !== ownerId) {
      this.logger.info("ignoring direct message from non-owner", {
        senderId: message.sender.id,
      });
      return;
    }
    const dedupKey = `${message.platform}:${message.messageId}`;
    if (this.dedup.has(dedupKey) || this.activeMessageIds.has(dedupKey)) return;
    this.activeMessageIds.add(dedupKey);
    const command = parseOwnerCommand(message.text);
    if (command) {
      try {
        const reply = await this.handleOwnerCommand(message, command);
        await this.safeReply(message, reply);
      } catch (error) {
        this.logger.error("owner command failed", {
          command: command.command,
          error: toErrorMessage(error),
        });
        await this.safeReply(message, `命令失败：${toErrorMessage(error)}`);
      } finally {
        this.activeMessageIds.delete(dedupKey);
      }
      await this.markProcessed(message);
      return;
    }
    if (this.config.context.enabled && this.config.context.storeOwnerDm) {
      this.chatContext.append(
        `${message.platform}:${message.chat.id}`,
        {
          messageId: message.messageId,
          senderId: message.sender.id,
          ...(message.sender.displayName ? { senderName: message.sender.displayName } : {}),
          text: message.text,
          at: message.createdAt,
          mentionMe: false,
          mentionBot: false,
          origin: "owner_dm",
        },
        {
          platform: message.platform,
          chatId: message.chat.id,
          ...(message.chat.name ? { chatName: message.chat.name } : {}),
        },
      );
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
          if (ok) await this.markProcessed(message);
          await this.audit.append({
            actor: message.sender,
            action: "direct_message_replied",
            details: { messageId: message.messageId },
          });
        } finally {
          this.activeMessageIds.delete(dedupKey);
        }
      },
    });
    try {
      await job;
    } catch (error) {
      this.activeMessageIds.delete(dedupKey);
      this.logger.error("direct message failed", {
        messageId: message.messageId,
        error: toErrorMessage(error),
      });
      await this.safeReply(
        message,
        `处理失败：${toErrorMessage(error)}\n请检查 opencode serve 是否运行，或稍后重试。`,
      );
    }
  }

  private recentKey(message: IncomingMessage): string {
    return `${message.platform}:${message.chat.id}:${message.sender.id}`;
  }

  private rememberRecent(message: IncomingMessage): void {
    if (!this.config.context.burstGrouping) return;
    const key = this.recentKey(message);
    const list = this.recentMessages.get(key) ?? [];
    list.push(message);
    const cutoff = Date.now() - 5 * 60_000;
    const trimmed = list.filter((item) => item.createdAt >= cutoff).slice(-20);
    this.recentMessages.set(key, trimmed);
    while (this.recentMessages.size > 500) {
      const oldest = this.recentMessages.keys().next().value;
      if (oldest === undefined) break;
      this.recentMessages.delete(oldest);
    }
  }

  private collectBurst(message: IncomingMessage): IncomingMessage[] {
    if (!this.config.context.burstGrouping) return [];
    const key = this.recentKey(message);
    const all = this.recentMessages.get(key) ?? [];
    const windowMs = this.config.context.burstWindowSeconds * 1000;
    const result: IncomingMessage[] = [];
    let lastAt = message.createdAt;
    let chars = 0;
    for (const item of all) {
      if (item.messageId === message.messageId) continue;
      if (item.chat.id !== message.chat.id) continue;
      if (item.sender.id !== message.sender.id) continue;
      if (item.createdAt <= message.createdAt) continue;
      if (item.createdAt - lastAt > windowMs) break;
      if (result.length >= this.config.context.burstMaxMessages) break;
      chars += item.text.length;
      if (chars > this.config.context.burstMaxChars) break;
      result.push(item);
      lastAt = item.createdAt;
    }
    return result;
  }

  private async waitForBurst(message: IncomingMessage, signal: AbortSignal): Promise<void> {
    if (!this.config.context.burstGrouping) return;
    const waitMs = this.config.context.burstWaitMs;
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, waitMs);
      timer.unref?.();
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  private async applyBurstGrouping(
    message: IncomingMessage,
    signal: AbortSignal,
  ): Promise<IncomingMessage[]> {
    const candidates = this.collectBurst(message);
    if (candidates.length === 0) return [];
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

  private async handleMessage(message: IncomingMessage, signal: AbortSignal): Promise<void> {
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
    if (this.pollingEnabled) return;
    await this.handleGroupScan(message, signal);
  }

  private handleBotMention(
    message: IncomingMessage,
    signal: AbortSignal,
  ): Promise<void> {
    return this.botMentionFlow.handle(message, signal);
  }

  private handleMeMention(
    message: IncomingMessage,
    signal: AbortSignal,
  ): Promise<void> {
    return this.meMentionFlow.handle(message, signal);
  }

  private shouldReplyToMention(
    message: IncomingMessage,
    classification: Classification | undefined,
  ): Promise<{ reply: boolean; reason: string }> {
    return this.replyService.shouldReplyToMention(message, classification);
  }

  private createReplyTask(
    message: IncomingMessage,
    classification: Classification | undefined,
  ): Promise<TaskRecord> {
    return this.replyService.createReplyTask(message, classification);
  }

  private sendReplyApproval(
    task: TaskRecord,
    message: IncomingMessage,
    draftSource: IncomingMessage = message,
    depth: ReplyDepth = "answer",
  ): Promise<void> {
    return this.replyService.sendReplyApproval(task, message, draftSource, depth);
  }

  private async handlePolledBatch(messages: IncomingMessage[]): Promise<void> {
    let failed = false;
    const candidates = messages.filter((message) => {
      if (message.senderType !== "user") return false;
      if (message.chat.kind !== "group") return false;
      if (this.config.policy.defaultDenyGroups && !this.groupIds.has(message.chat.id)) return false;
      return true;
    });
    if (candidates.length === 0) return;

    for (const message of candidates) {
      if (!this.isMention(message)) continue;
      try {
        await this.onMessage(message, true);
      } catch (error) {
        failed = true;
        this.logger.error("polled mention handling failed", {
          messageId: message.messageId,
          error: toErrorMessage(error),
        });
      }
    }
    const plain = candidates.filter((message) => !this.isMention(message));
    if (plain.length === 0) return;

    const fresh = plain.filter((message) => {
      const key = `${message.platform}:${message.messageId}`;
      return !this.dedup.has(key) && !this.activeMessageIds.has(key);
    });
    if (fresh.length === 0) return;
    const perSender = new Map<string, number>();
    const capped = fresh.filter((message) => {
      const count = (perSender.get(message.sender.id) ?? 0) + 1;
      if (count > this.config.botReply.maxMessagesPerSenderPerRun) return false;
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
      await this.sendToApprover(
        `本轮消息超过预算，仅处理 ${limitedMessages.length}/${capped.length} 条；剩余留待下一轮。`,
      );
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
          } finally {
            for (const message of capped) {
              this.activeMessageIds.delete(`${message.platform}:${message.messageId}`);
            }
          }
        },
      });
    } catch (error) {
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

  private async digestWithoutFilter(messages: IncomingMessage[]): Promise<void> {
    const usable = messages.filter(
      (message) => message.senderType === "user" && message.text.trim().length > 0,
    );
    if (usable.length === 0) {
      for (const message of messages) await this.markProcessed(message);
      return;
    }
    await this.sendOwnerDigest(usable, []);
    for (const message of messages) await this.markProcessed(message);
  }

  private async sendOwnerDigest(
    messages: IncomingMessage[],
    items: import("./types.js").Classification[],
  ): Promise<void> {
    const byId = new Map(items.map((item) => [item.messageId, item]));
    const lines: string[] = [];
    const related: IncomingMessage[] = [];
    for (const message of messages) {
      const item = byId.get(message.messageId);
      if (item?.relevant) related.push(message);
    }
    const highlighted = related.length > 0 ? related : messages.slice(0, 5);
    for (const message of highlighted.slice(0, 8)) {
      const item = byId.get(message.messageId);
      const sender = message.sender.displayName ?? message.sender.id;
      const time = formatLocalTime(message.createdAt);
      const reason = item?.reason ? `｜判断：${truncate(item.reason, 80)}` : "";
      const action = item?.actionability ? `｜类型：${item.actionability}` : "";
      lines.push(
        [
          `• ${time} ${sender}${action}${reason}`,
          `  ${truncate(message.text.replace(/\s+/g, " "), 160)}`,
          `  message_id: ${message.messageId}`,
        ].join("\n"),
      );
    }
    const summary =
      related.length > 0
        ? `与你相关 ${related.length} 条，共 ${messages.length} 条`
        : `本轮 ${messages.length} 条，未识别出强相关；下面是最近的`;
    await this.sendToOwner([`群消息分析：${summary}`, ...lines].join("\n\n"));
  }

  private async handlePolledBatchJob(
    messages: IncomingMessage[],
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.filterEnabled) {
      await this.digestWithoutFilter(messages);
      return;
    }
    const { items, stats } = await this.relevance.classify(messages, signal);
    if (stats.totalTokens > this.config.budget.maxTokensPerRun) {
      await this.sendToApprover(
        `本轮筛选 token 超预算：${stats.totalTokens}/${this.config.budget.maxTokensPerRun}，已停止后续批次。`,
      );
    }
    if (stats.failures > 0) {
      const failed = stats.failedMessageIds;
      await this.sendToApprover(
        `筛选失败：${failed.length} 条消息未处理，已保留待重试。\n原因见日志；不会静默丢弃。`,
      );
    }
    const byId = new Map(items.map((item) => [item.messageId, item]));
    const failed = new Set(stats.failedMessageIds);
    for (const message of messages) {
      if (failed.has(message.messageId)) continue;
      const item = byId.get(message.messageId);
      if (!item?.relevant) {
        await this.markProcessed(message);
        continue;
      }
      this.appendContextForScan(message);
      if (
        item.actionability === "task" &&
        item.confidence >= this.config.filter.minTaskConfidence
      ) {
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

  private async handleGroupScan(message: IncomingMessage, signal: AbortSignal): Promise<void> {
    const classification = await this.classifyOne(message, signal);
    if (!classification?.relevant) return;
    let handled = false;
    if (
      classification.actionability === "task" &&
      classification.confidence >= this.config.filter.minTaskConfidence
    ) {
      const task = await this.ensureTask(message, classification, "group_scan");
      if (task) handled = true;
    } else {
      handled = await this.sendToApprover(
        [
          "群消息可能与你相关",
          `群：${message.chat.name ?? message.chat.id}`,
          `发送人：${message.sender.displayName ?? message.sender.id}`,
          `内容：${truncate(message.text, 200)}`,
          `判断：${classification.reason}`,
          `建议：${suggestedActionLabel(classification.actionability)}`,
        ].join("\n"),
      );
    }
    if (handled) await this.markProcessed(message);
  }

  private classifyOne(
    message: IncomingMessage,
    signal: AbortSignal,
  ): Promise<Classification | undefined> {
    return this.intentService.classifyOne(message, signal);
  }

  private ensureTask(
    message: IncomingMessage,
    classification: Classification | undefined,
    source: TaskRecord["source"],
  ): Promise<TaskRecord | undefined> {
    return this.taskService.ensureTask(message, classification, source);
  }

  private analyzeTask(task: TaskRecord): Promise<void> {
    return this.taskService.analyzeTask(task);
  }

  private async createApprovalCard(task: TaskRecord, source: string): Promise<void> {
    const analysis = await this.latestAnalysis(task.id);
    if (!analysis) return;
    await this.sendApproval(task, analysis);
    void source;
  }

  private async sendApproval(
    task: TaskRecord,
    analysis: TaskAnalysis,
  ): Promise<void> {
    if (this.pending.get(`${task.id}:develop`) || this.pending.get(`${task.id}:reply`)) return;
    const repo = this.config.repos.find((item) => analysis.repos.includes(item.id)) ?? this.config.repos[0];
    const view = {
      taskId: task.id,
      planHash: analysis.planHash,
      mode: "develop" as const,
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
    if (!ownerId) throw new Error("owner is not bound; cannot send approval card");
    const target = { kind: "user" as const, userId: ownerId };
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

  async recoverOnStartup(): Promise<void> {
    const recovery = this.config.recovery;
    if (!recovery.enabled) return;
    if (!this.started) return;
    if (recovery.resumeTasks) {
      await this.resumeOpenTasks();
    }
    if (recovery.onStartup) {
      await this.pullStartupWindow();
    }
  }

  private async pullStartupWindow(): Promise<void> {
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
        if (result.messages.length === 0) continue;
        const messageIds = result.messages.map((message) => `${message.platform}:${message.messageId}`);
        const unprocessed = result.messages.filter((message) => !this.dedup.has(
          `${message.platform}:${message.messageId}`,
        ));
        this.logger.info("startup recovery fetched", {
          chatId,
          fetched: result.messages.length,
          unprocessed: unprocessed.length,
          unique: new Set(messageIds).size,
        });
        if (unprocessed.length === 0) continue;
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
          if (plain.length > 0) await this.ingestBatch(plain);
        }
      } catch (error) {
        this.logger.error("startup recovery failed for group; continuing", {
          chatId,
          error: toErrorMessage(error),
        });
      }
    }
  }

  private async resumeOpenTasks(): Promise<void> {
    const recovery = this.config.recovery;
    const now = Date.now();
    const maxAgeMs = recovery.resumeMaxAgeDays * 86_400_000;
    const tasks = await this.tasks.list();
    let resumed = 0;
    let interrupted = 0;
    for (const task of tasks) {
      if (now - task.updatedAt > maxAgeMs) continue;
      if (task.state === "done" || task.state === "rejected" || task.state === "canceled") {
        continue;
      }
      if (task.state === "executing" || task.state === "verifying") {
        const staleMs = recovery.staleRunningMinutes * 60_000;
        if (now - task.updatedAt < staleMs) continue;
        task.state = "awaiting_approval";
        task.updatedAt = now;
        await this.tasks.save(task);
        interrupted++;
        await this.sendToOwner(
          `上次执行被中断，已暂停等待你重新批准：${task.title}\n不会自动重放代码修改。`,
        );
        continue;
      }
      if (
        (task.state === "awaiting_approval" || task.state === "needs_info") &&
        this.pending.findForTask(task.id)
      ) {
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
      if (
        (task.state === "awaiting_approval" || task.state === "needs_info") &&
        (nudgeMs === 0 || now - (task.lastNudgeAt ?? 0) > nudgeMs)
      ) {
        task.lastNudgeAt = now;
        task.updatedAt = now;
        await this.tasks.save(task);
        await this.sendToOwner(
          `未完成任务提醒：${task.title}\n状态：${task.state}\n发送「查看任务」可列出详情（后续实现）。`,
        );
        resumed++;
      }
    }
    this.logger.info("task resume finished", { resumed, interrupted });
    if (resumed > 0 || interrupted > 0) {
      await this.sendToOwner(
        `启动恢复：续作 ${resumed} 个未完成任务，中断 ${interrupted} 个执行。`,
      );
    }
  }

  private sweepExpiredApprovals(): Promise<void> {
    return this.approvalService.sweepExpiredApprovals();
  }

  private onAction(action: PlatformAction): Promise<PlatformActionResult> {
    return this.approvalService.onAction(action);
  }

  private async approveReply(action: PlatformAction, pending: PendingCard): Promise<void> {
    const task = await this.tasks.get(action.taskId);
    if (!task) return;
    const chatId = pending.chatId;
    const sourceMessageId = pending.sourceMessageId;
    if (!chatId || !sourceMessageId) {
      await this.sendToApprover("代答失败：缺少原消息信息");
      return;
    }
    const original: IncomingMessage = {
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
    } catch (error) {
      this.logger.error("approved reply failed", {
        taskId: task.id,
        error: toErrorMessage(error),
      });
      await this.sendToApprover(`代答失败：${task.title}\n${toErrorMessage(error)}`);
    }
  }

  private async latestAnalysis(taskId: string): Promise<TaskAnalysis | undefined> {
    const dir = join(this.stateDir, "analyses", taskId);
    const index = await readJsonFile<{ version: number } | undefined>(
      join(dir, "index.json"),
      undefined,
    );
    const version = index?.version ?? 1;
    return readJsonFile<TaskAnalysis | undefined>(join(dir, `${version}.json`), undefined);
  }

  private coordinatorSession(
    platform: string,
    chatId: string,
    directory: string,
    title: string,
  ): Promise<string> {
    return this.sessionManager.coordinatorSession(platform, chatId, directory, title);
  }

  private runWorker(
    input: WorkerInput,
    promptText: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.sessionManager.runWorker(input, promptText, signal);
  }

  private createChildSession(input: ChildInput): Promise<{ sessionId: string; release: () => void }> {
    return this.sessionManager.createChildSession(input);
  }

  private archiveTaskChildren(taskId: string): Promise<void> {
    return this.sessionManager.archiveTaskChildren(taskId);
  }

  private sweepSessions(): Promise<void> {
    return this.sessionManager.sweepSessions();
  }

  private finishSession(
    sessionId: string,
    title: string,
    directory: string,
    purpose: string,
  ): Promise<void> {
    return this.sessionManager.finishSession(sessionId, title, directory, purpose);
  }

  private memoryBlock(platform: string, chatId: string | undefined, text: string): string {
    return this.contextService.memoryBlock(platform, chatId, text);
  }

  private rememberFromMention(
    message: IncomingMessage,
    intent: BotIntent,
    analysis?: string,
  ): void {
    if (!this.config.memory.enabled || !this.config.memory.extract) return;
    if (!this.config.memory.autoExtractFromMentions) return;
    const projectId = this.projectStore.get(message.chat.id)?.projectId;
    const base = {
      platform: message.platform,
      chatId: message.chat.id,
      ...(projectId ? { projectId } : {}),
      sourceMessageIds: [message.messageId],
      tags: [intent.kind, ...this.config.filter.profile.projects],
    };
    const summary = intent.summary ?? truncate(message.text, 160);
    const kind: MemoryKind =
      intent.kind === "task"
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
        if (trimmed.length < 6) continue;
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

  private appendContextForScan(message: IncomingMessage): void {
    if (!this.config.context.enabled || !this.config.context.storeRelevantScan) return;
    this.chatContext.append(
      `${message.platform}:${message.chat.id}`,
      {
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
      },
      {
        platform: message.platform,
        chatId: message.chat.id,
        ...(message.chat.name ? { chatName: message.chat.name } : {}),
      },
    );
  }

  private createGroupSession(
    platform: string,
    chatId: string,
    directory: string,
  ): Promise<string> {
    return this.sessionManager.createGroupSession(platform, chatId, directory);
  }

  private summaryText(platform: string, chatId: string): string {
    return this.contextService.summaryText(platform, chatId);
  }

  private async updateGroupSummary(platform: string, chatId: string): Promise<void> {
    if (this.config.groupSession?.enabled === false) return;
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
    } finally {
      if (this.groupLocks.get(key) === next) this.groupLocks.delete(key);
    }
  }

  private async doUpdateGroupSummary(platform: string, chatId: string): Promise<void> {
    const every = this.config.groupSession?.summaryEveryMessages ?? 8;
    const maxChars = this.config.groupSession?.summaryMaxChars ?? 1500;
    const timeoutMs = this.config.groupSession?.timeoutMs ?? 30_000;
    const key = `${platform}:${chatId}`;
    const current = this.groupContext.get(key);
    const since = current?.lastMessageAt ?? 0;
    const messages = this.chatContext.recent(key, 50).filter((item) => item.at > since);
    if (messages.length < every) return;
    const directory = (await this.resolveProject(chatId)).worktree;
    const sessionId = await this.createGroupSession(platform, chatId, directory);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("summary timed out")), timeoutMs);
    let raw: string;
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
          ...messages.map(
            (item) => `- ${item.senderName ?? item.senderId}: ${truncateMiddle(item.text, 500)}`,
          ),
        ].join("\n"),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    let parsed: any;
    try {
      parsed = parseJsonLoose(raw);
    } catch {
      parsed = {};
    }
    const summaryText = typeof parsed?.summary === "string" ? parsed.summary : raw;
    const record: GroupSummary = {
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

  private evidenceRecall(message: IncomingMessage): string[] {
    return this.contextService.evidenceRecall(message);
  }

  private quotedContext(message: IncomingMessage): string[] {
    return this.contextService.quotedContext(message);
  }

  private analysisContext(task: TaskRecord): Promise<AnalysisContext> {
    return this.contextService.analysisContext(task);
  }

  private async resolveProject(chatId: string): Promise<{
    worktree: string;
    projectId?: string;
    resolved: boolean;
    reason: string;
  }> {
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
    let resolution: {
      worktree: string;
      projectId?: string;
      resolved: boolean;
      reason: string;
    };
    if (selection) {
      resolution = {
        worktree: selection.project.worktree,
        projectId: selection.project.id,
        resolved: true,
        reason: selection.reason,
      };
      this.logger.info("project resolved", candidateLogFields(selection));
    } else if (this.config.repos[0]?.path) {
      resolution = {
        worktree: this.config.repos[0].path,
        resolved: true,
        reason: "repos[0] fallback",
      };
      this.logger.warn("no active project resolved; using repos[0]", {
        worktree: resolution.worktree,
      });
    } else if (this.config.project.fallbackWorktree) {
      resolution = {
        worktree: this.config.project.fallbackWorktree,
        resolved: true,
        reason: "fallbackWorktree",
      };
      this.logger.warn("no active project resolved; using fallbackWorktree", {
        worktree: resolution.worktree,
      });
    } else {
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
      this.chatContext.bindProject(
        `${this.options.platform.platform}:${chatId}`,
        selection.project.id,
        selection.project.worktree,
      );
    }

    return resolution;
  }

  private askOpenCode(
    message: IncomingMessage,
    style: ReplyStyle,
    signal: AbortSignal,
    depth: ReplyDepth = "answer",
  ): Promise<string> {
    return this.replyService.draft(message, style, signal, depth);
  }

  private async safeReply(message: IncomingMessage, text: string): Promise<boolean> {
    const key = `reply:${message.platform}:${message.messageId}:${sha256(text).slice(0, 12)}`;
    if (this.outbound.has(key)) {
      this.logger.info("skip duplicate reply", { messageId: message.messageId });
      return true;
    }
    try {
      await this.sendLimiter.take();
      await this.options.platform.reply(
        { chatId: message.chat.id, messageId: message.messageId },
        { kind: "text", text, uuid: stableUuid(key) },
      );
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
    } catch (error) {
      this.logger.error("failed to reply", {
        messageId: message.messageId,
        error: toErrorMessage(error),
      });
      return false;
    }
  }

  private async sendToApprover(text: string): Promise<boolean> {
    return this.sendToOwner(text);
  }

  private async markProcessed(message: IncomingMessage): Promise<void> {
    this.dedup.add(`${message.platform}:${message.messageId}`);
    await this.dedup.flush();
  }

  private sanitize(text: string): string {
    return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
  }

  stats(): ReturnType<ConcurrentDispatcher["snapshot"]> {
    return this.dispatcher.snapshot();
  }


}

function requireStateDir(config: AppConfig): string {
  const stateDir = config.app.stateDir;
  if (!stateDir) throw new Error("app.stateDir is required");
  return stateDir.startsWith("~") ? join(process.env.HOME ?? "", stateDir.slice(2)) : stateDir;
}

function createFilterClient(options: RuntimeOptions, logger: Logger): LlmClient {
  if (options.llm) return options.llm;
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
    baseUrl: config.filter.baseUrl!,
    apiKey: secrets.filterApiKey!,
    model: config.filter.model,
    timeoutMs: config.filter.timeoutMs,
    logger: logger.child("llm"),
  });
}

function suggestedActionLabel(actionability: Classification["actionability"]): string {
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

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}


