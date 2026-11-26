import { join } from "node:path";
import type { AppConfig } from "./config.js";
import type { AuditLog } from "./audit.js";
import type { ContextService } from "./context-service.js";
import type { Logger } from "./logger.js";
import type { MemoryStore } from "./memory-store.js";
import type { SessionManager, SessionPermission } from "./session-manager.js";
import type { TaskStore } from "./task-store.js";
import type { TaskEventType } from "./task-events.js";
import type { TaskNotification, TaskRun } from "./task-state-db.js";
import type { PromptAttachment } from "./opencode.js";
import type {
  AnalysisVerification,
  Classification,
  IncomingMessage,
  NotificationView,
  TaskAnalysis,
  TaskRecord,
} from "./types.js";
import {
  deterministicVerification,
  mergeVerification,
  parseVerification,
} from "./analysis-verify.js";
import { parseAnalysis } from "./analysis.js";
import { buildAnalysisPrompt } from "./prompts.js";
import { makeDedupKey } from "./relevance.js";
import { formatLocalTime, sha256, toErrorMessage, truncate, writeJsonAtomic } from "./util.js";

export interface TaskServiceOptions {
  config: AppConfig;
  stateDir: string;
  stateDirFor?(chatId: string): string;
  workspaceDirFor?(chatId: string): string | undefined;
  tasks: TaskStore;
  audit: AuditLog;
  contextService: ContextService;
  sessionManager: SessionManager;
  logger: Logger;
  readOnlyPermission: SessionPermission[];
  conversationIdFor?(platform: string, chatId: string): string;
  loadMedia?(task: TaskRecord): Promise<{
    attachments: PromptAttachment[];
    documents: string[];
  }>;
  memory: MemoryStore;
  resolveProject(chatId: string): Promise<{
    worktree: string;
    resolved: boolean;
    workspace?: boolean;
    workspaceRoot?: string;
    workspaceProjects?: Array<{ name: string; path: string; description?: string }>;
    workspaceDocs?: string[];
    writableProjects?: string[];
    coreProjects?: string[];
    referenceProjects?: string[];
  }>;
  projectId(chatId: string): string | undefined;
  chatLabelFor?(chatId: string): Promise<string | undefined>;
  senderLabelFor?(userId: string, messageId?: string): Promise<string | undefined>;
  messageLinkFor?(chatId: string, messageId: string): Promise<string | undefined>;
  startAnalysis(task: TaskRecord): void;
  sendToApprover(text: string): Promise<boolean>;
  sendOwnerNotification?(view: NotificationView): Promise<boolean>;
  sendOwnerNotificationResult?(view: NotificationView): Promise<{ ok: boolean; messageId?: string }>;
  linkTaskMessage?(chatId: string, messageId: string, taskId: string): Promise<void>;
  publishTaskEvent?(input: {
    chatId: string;
    taskId: string;
    type: TaskEventType;
    payload?: Record<string, unknown>;
  }): Promise<unknown>;
  recordTaskNotification?(input: Omit<TaskNotification, "id" | "createdAt">): Promise<unknown>;
  startTaskRun?(input: { taskId: string; chatId: string; role: string; stage: string }): Promise<TaskRun>;
  attachTaskRunSession?(runId: string, sessionId: string, chatId: string): Promise<unknown>;
  finishTaskRun?(runId: string, chatId: string, status: string): Promise<unknown>;
  touchTaskRun?(runId: string, chatId: string): Promise<unknown>;
  sendApproval(task: TaskRecord, analysis: TaskAnalysis): Promise<void>;
}

export class TaskService {
  constructor(private readonly options: TaskServiceOptions) {}

  async analyzeTask(task: TaskRecord): Promise<void> {
    const run = await this.options.startTaskRun?.({
      taskId: task.id,
      chatId: task.chatId,
      role: "analysis",
      stage: "analyzing",
    });
    const heartbeat = run
      ? setInterval(() => {
          void this.options.touchTaskRun?.(run.id, task.chatId).catch(() => undefined);
        }, 15_000)
      : undefined;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("analysis timed out")),
      this.options.config.concurrency.analysisTimeoutMs,
    );
    let analysis: TaskAnalysis;
    let verification: AnalysisVerification | undefined;
    try {
      analysis = await this.buildAnalysis(
        task,
        controller.signal,
        run
          ? async (sessionId) => {
              await this.options.attachTaskRunSession?.(run.id, sessionId, task.chatId);
            }
          : undefined,
      );
      verification = await this.verifyAnalysis(task, analysis, controller.signal);
      analysis.verification = verification;
      if (verification.drift === "major") {
        analysis.needsInfo = true;
        analysis.openQuestions = [
          ...new Set([...analysis.openQuestions, ...verification.reasons]),
        ];
      }
      if ((task.actionability ?? "task") === "task") {
        const missing: string[] = [];
        if (analysis.scope.length === 0) missing.push("缺少任务范围");
        if (analysis.plan.length === 0) missing.push("缺少执行计划");
        if (!analysis.files?.length) missing.push("缺少计划文件");
        if (analysis.acceptanceCriteria.length === 0) missing.push("缺少验收标准");
        if (missing.length > 0) {
          analysis.needsInfo = true;
          analysis.openQuestions = [
            ...new Set([...analysis.openQuestions, ...missing]),
          ];
        }
      }
    } catch (error) {
      task.state = "needs_info";
      task.updatedAt = Date.now();
      await this.options.tasks.save(task);
      await this.options.audit.append({
        actor: { system: true },
        action: "analysis_failed",
        taskId: task.id,
        details: { error: toErrorMessage(error) },
      });
      await this.options.publishTaskEvent?.({
        chatId: task.chatId,
        taskId: task.id,
        type: "analysis.failed",
        payload: { error: toErrorMessage(error) },
      });
      await this.options.sendToApprover(
        `任务分析失败：${task.title}\n原因：${toErrorMessage(error)}\n可回复 /分析 ${task.id} 重试。`,
      );
      if (run) await this.options.finishTaskRun?.(run.id, task.chatId, "failed");
      return;
    } finally {
      clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
    }
    await this.options.tasks.save(task);
    const stateDir = this.options.stateDirFor?.(task.chatId) ?? this.options.stateDir;
    await writeJsonAtomic(
      join(stateDir, "analyses", task.id, `${analysis.version}.json`),
      analysis,
    );
    await writeJsonAtomic(
      join(stateDir, "analyses", task.id, "index.json"),
      { version: analysis.version },
    );
    const workspaceDir = this.options.workspaceDirFor?.(task.chatId);
    if (workspaceDir) {
      await writeJsonAtomic(
        join(workspaceDir, "analysis", task.id, `${analysis.version}.json`),
        analysis,
      );
      await writeJsonAtomic(
        join(workspaceDir, "analysis", task.id, "index.json"),
        { version: analysis.version },
      );
    }
    this.rememberTaskOutcome(task, analysis);
    task.state = analysis.needsInfo ? "needs_info" : "awaiting_approval";
    task.lastAnalyzedAt = Date.now();
    task.updatedAt = Date.now();
    await this.options.tasks.save(task);
    if (run) await this.options.finishTaskRun?.(run.id, task.chatId, task.state);
    await this.options.audit.append({
      actor: { system: true },
      action: "analysis_verified",
      taskId: task.id,
      details: {
        drift: verification?.drift ?? "unknown",
        unverified: verification?.unverifiedIdentifiers.length ?? 0,
      },
    });
    await this.options.publishTaskEvent?.({
      chatId: task.chatId,
      taskId: task.id,
      type: "analysis.completed",
      payload: { needsInfo: analysis.needsInfo, drift: verification?.drift ?? "unknown" },
    });
    if (analysis.needsInfo) {
      await this.options.sendToApprover(
        `任务需要补充信息：${task.title}\n${analysis.openQuestions
          .map((question) => `- ${question}`)
          .join("\n")}`,
      );
      return;
    }
    await this.options.sendApproval(task, analysis);
  }

  async appendSupplement(
    task: TaskRecord,
    message: IncomingMessage,
  ): Promise<TaskRecord["state"]> {
    const text = message.text.trim();
    if (!text) return task.state;
    if (task.supplements?.some((item) => item.messageId === message.messageId)) {
      return task.state;
    }
    task.supplements = [
      ...(task.supplements ?? []),
      {
        messageId: message.messageId,
        text,
        senderId: message.sender.id,
        ...(message.sender.displayName ? { senderName: message.sender.displayName } : {}),
        createdAt: message.createdAt,
      },
    ];
    task.updatedAt = Date.now();
    await this.options.tasks.save(task);
    await this.options.audit.append({
      actor: { system: true },
      action: "task_supplement",
      taskId: task.id,
      details: { messageId: message.messageId },
    });
    await this.options.publishTaskEvent?.({
      chatId: task.chatId,
      taskId: task.id,
      type: "task.supplement",
      payload: { messageId: message.messageId },
    });
    return task.state;
  }

  async ensureTask(
    message: IncomingMessage,
    classification: Classification | undefined,
    source: TaskRecord["source"],
    options?: { autoAnalyze?: boolean },
  ): Promise<TaskRecord | undefined> {
    const taskHint = classification?.task;
    const title = taskHint?.title ?? truncate(message.text.split("\n")[0] ?? message.text, 60);
    const dedupKey = makeDedupKey({
      platform: message.platform,
      chatId: message.chat.id,
      title,
      project: taskHint?.project,
      requesterId: message.sender.id,
    });
    const existingId = this.options.tasks.findByDedupKey(dedupKey);
    const now = Date.now();
    if (existingId) {
      const existing = await this.options.tasks.get(existingId);
      if (existing) {
        if (!existing.messageIds.includes(message.messageId)) {
          existing.messageIds.push(message.messageId);
          existing.updatedAt = now;
          await this.options.tasks.save(existing);
        }
        return existing;
      }
    }
    if (taskHint?.topic) {
      const recent = (await this.options.tasks.list()).find(
        (item) =>
          item.chatId === message.chat.id &&
          item.topic === taskHint.topic &&
          item.requester.id === message.sender.id &&
          now - item.updatedAt < 2 * 3600_000 &&
          !item.archivedAt &&
          !["done", "rejected", "canceled"].includes(item.state),
      );
      if (recent) {
        recent.messageIds = [...new Set([...recent.messageIds, message.messageId])];
        recent.attachments = [...(recent.attachments ?? []), ...(message.attachments ?? [])];
        recent.updatedAt = now;
        await this.options.tasks.save(recent);
        return recent;
      }
    }
    const task: TaskRecord = {
      id: `task_${sha256(`${dedupKey}:${message.messageId}`).slice(0, 12)}`,
      platform: message.platform,
      chatId: message.chat.id,
      ...(this.options.conversationIdFor?.(message.platform, message.chat.id)
        ? {
            conversationId: this.options.conversationIdFor(
              message.platform,
              message.chat.id,
            ),
          }
        : {}),
      ...(message.chat.name ? { chatName: message.chat.name } : {}),
      messageIds: message.messageIds ?? [message.messageId],
      ...(message.messageLink ? { messageLink: message.messageLink } : {}),
      source,
      requester: message.sender,
      title,
      excerpt: truncate(message.text, 500),
      ...(taskHint?.topic ? { topic: taskHint.topic } : {}),
      ...(message.attachments?.length ? { attachments: message.attachments } : {}),
      ...(taskHint?.project ? { project: taskHint.project } : {}),
      ...(taskHint?.deadline ? { deadline: taskHint.deadline } : {}),
      keywords: this.options.config.filter.profile.keywords.filter((keyword) =>
        message.text.includes(keyword),
      ),
      relevance: {
        reason: classification?.reason ?? "mentioned",
        confidence: classification?.confidence ?? 1,
      },
      actionability: classification?.actionability ?? "task",
      dedupKey,
      state: "analyzing",
      createdAt: now,
      updatedAt: now,
    };
    const atomicSave = await this.options.tasks.saveWithLinks?.(task, task.messageIds);
    if (atomicSave !== true) {
      await this.options.tasks.save(task);
      for (const messageId of task.messageIds) {
        await this.options.linkTaskMessage?.(task.chatId, messageId, task.id);
      }
    }
    await this.options.audit.append({
      actor: { system: true },
      action: "task_created",
      taskId: task.id,
      details: { source, messageId: message.messageId },
    });
    await this.options.publishTaskEvent?.({
      chatId: task.chatId,
      taskId: task.id,
      type: "task.created",
      payload: { source },
    });
    const autoAnalyze =
      options?.autoAnalyze ??
      (source === "group_scan" ? false : this.options.config.policy.autoAnalyzeTasks);
    if (!autoAnalyze) {
      task.state = "needs_info";
      task.updatedAt = Date.now();
      task.lastNudgeAt = task.updatedAt;
      let group = task.chatName?.trim();
      if (!group && this.options.chatLabelFor) {
        try {
          group = (await this.options.chatLabelFor(task.chatId))?.trim();
        } catch (error) {
          this.options.logger.warn("failed to resolve task chat name", {
            chatId: task.chatId,
            error: toErrorMessage(error),
          });
        }
      }
      group = group || "未知群";
      let sender = task.requester.displayName?.trim();
      if (!sender && this.options.senderLabelFor) {
        try {
          sender = (
            await this.options.senderLabelFor(task.requester.id, task.messageIds[0])
          )?.trim();
        } catch (error) {
          this.options.logger.warn("failed to resolve task sender name", {
            userId: task.requester.id,
            error: toErrorMessage(error),
          });
        }
      }
      sender = sender || "成员";
      let messageLink = task.messageLink;
      if (!messageLink && this.options.messageLinkFor) {
        try {
          messageLink = await this.options.messageLinkFor(task.chatId, task.messageIds[0]!);
        } catch (error) {
          this.options.logger.warn("failed to resolve task message link", {
            chatId: task.chatId,
            error: toErrorMessage(error),
          });
        }
      }
      if (!task.chatName && group !== "未知群") task.chatName = group;
      if (!task.requester.displayName && sender !== "成员") {
        task.requester.displayName = sender;
      }
      if (!task.messageLink && messageLink) task.messageLink = messageLink;
      await this.options.tasks.save(task);
      const meta = `${formatLocalTime(task.createdAt)} ${sender} · task`;
      const link = {
        label: messageLink ? "打开原消息" : "打开群聊",
        url:
          messageLink ??
          `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(task.chatId)}`,
      };
      if (this.options.sendOwnerNotificationResult) {
        const result = await this.options.sendOwnerNotificationResult({
          title: `候选任务 · ${group}`,
          headerMeta: { right: meta },
          sections: [
            {
              title: task.title,
              meta: "待确认",
              ...(task.excerpt
                ? { quote: truncate(task.excerpt.replace(/\s+/g, " "), 160) }
                : {}),
              detail: "暂不自动分析",
            },
          ],
          link,
          footer: `如需分析，回复 /分析 ${task.id}`,
        });
        if (result.messageId) {
          task.candidateMessageId = result.messageId;
          await this.options.tasks.save(task);
          await this.options.linkTaskMessage?.(task.chatId, result.messageId, task.id);
          await this.options.recordTaskNotification?.({
            taskId: task.id,
            chatId: task.chatId,
            kind: "candidate",
            title: `候选任务 · ${group}`,
            summary: truncate(task.title, 160),
            cardMessageId: result.messageId,
            ...(task.messageIds[0] ? { sourceMessageId: task.messageIds[0] } : {}),
            ...(task.messageLink ? { sourceUrl: task.messageLink } : {}),
          });
        }
      } else if (this.options.sendOwnerNotification) {
        await this.options.sendOwnerNotification({
          title: `候选任务 · ${group}`,
          headerMeta: { right: meta },
          sections: [
            {
              title: task.title,
              meta: "待确认",
              ...(task.excerpt
                ? { quote: truncate(task.excerpt.replace(/\s+/g, " "), 160) }
                : {}),
              detail: "暂不自动分析",
            },
          ],
          link,
          footer: `如需分析，回复 /分析 ${task.id}`,
        });
      } else {
        await this.options.sendToApprover(
          [
            "已记录候选任务，暂不自动分析",
            `群：${group}`,
            `${meta}`,
            `任务：${task.title}`,
            `如需分析，回复 /分析 ${task.id}`,
            `群聊：${link.url}`,
          ].join("\n"),
        );
      }
      return task;
    }
    this.options.startAnalysis(task);
    return task;
  }

  private rememberTaskOutcome(task: TaskRecord, analysis: TaskAnalysis): void {
    if (!this.options.config.memory.enabled || !this.options.config.memory.extract) return;
    if (!this.options.config.memory.autoExtractFromAnalysis) return;
    const projectId = this.options.projectId(task.chatId);
    this.options.memory.upsert({
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
      this.options.memory.upsert({
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
    void this.options.memory.flush();
  }

  private async buildAnalysis(
    task: TaskRecord,
    signal?: AbortSignal,
    onSession?: (sessionId: string) => void | Promise<void>,
  ): Promise<TaskAnalysis> {
    const media = (await this.options.loadMedia?.(task)) ?? {
      attachments: [],
      documents: [],
    };
    const attachments = media.attachments;
    const mediaDocuments = media.documents;
    const workspaceConfig = this.options.config.platforms.feishu.groups.find(
      (group) => group.chatId === task.chatId,
    )?.workspace;
    if (workspaceConfig) {
      const project = await this.options.resolveProject(task.chatId);
      if (!project.resolved) {
        return this.missingProjectAnalysis(task);
      }
      return this.buildAnalysisInWorktree(
        task,
        project.worktree,
        signal,
        project.workspaceProjects,
        project.workspaceDocs,
        attachments,
        mediaDocuments,
        project.writableProjects,
        project.referenceProjects,
        onSession,
      );
    }
    const repo = this.options.config.repos[0];
    if (!repo) {
      const project = await this.options.resolveProject(task.chatId);
      if (!project.resolved) {
        return this.missingProjectAnalysis(task);
      }
      return this.buildAnalysisInWorktree(
        task,
        project.worktree,
        signal,
        undefined,
        undefined,
        attachments,
        mediaDocuments,
        project.writableProjects,
        project.referenceProjects,
        onSession,
      );
    }
    const ctx = await this.options.contextService.analysisContext(task);
    const prompt = buildAnalysisPrompt({
      task,
      repositoryIds: this.options.config.repos.map((item) => item.id),
      directory: repo.path,
      context: ctx,
      ...(mediaDocuments.length > 0 ? { attachmentTexts: mediaDocuments } : {}),
    });
    const analysisAgent =
      this.options.config.opencode.analysisAgent ?? this.options.config.opencode.agent;
    const raw = await this.options.sessionManager.runWorker(
      {
        platform: task.platform,
        chatId: task.chatId,
        directory: repo.path,
        title: `${this.options.config.opencode.sessionTitlePrefix}:worker:analysis:${task.chatId}`,
        role: "analysis",
        taskId: task.id,
        ...(onSession ? { onSession } : {}),
        ...(this.options.conversationIdFor?.(task.platform, task.chatId)
          ? { conversationId: this.options.conversationIdFor(task.platform, task.chatId) }
          : {}),
        permission: this.options.readOnlyPermission,
        ...(analysisAgent ? { agent: analysisAgent } : {}),
        ...(this.options.config.analysis.model
          ? { model: this.options.config.analysis.model }
          : {}),
      },
      prompt,
      signal,
      attachments,
    );
    return parseAnalysis(raw, task, repo.id);
  }

  private async buildAnalysisInWorktree(
    task: TaskRecord,
    worktree: string,
    signal?: AbortSignal,
    workspaceProjects?: Array<{ name: string; path: string; description?: string }>,
    workspaceDocs?: string[],
    attachments: PromptAttachment[] = [],
    mediaDocuments: string[] = [],
    writableProjects: string[] = [],
    referenceProjects: string[] = [],
    onSession?: (sessionId: string) => void | Promise<void>,
  ): Promise<TaskAnalysis> {
    const ctx = await this.options.contextService.analysisContext(task);
    const prompt = buildAnalysisPrompt({
      task,
      repositoryIds: workspaceProjects?.length
        ? workspaceProjects.map((project) => project.name)
        : this.options.config.repos.map((item) => item.id),
      directory: worktree,
      context: ctx,
      ...(workspaceProjects ? { workspaceProjects } : {}),
      ...(workspaceDocs ? { workspaceDocs } : {}),
      ...(writableProjects.length > 0 ? { writableProjects } : {}),
      ...(referenceProjects.length > 0 ? { readonlyProjects: referenceProjects } : {}),
      ...(task.attachments?.length
        ? { attachmentNames: task.attachments.map((item) => item.name ?? item.kind) }
        : {}),
      ...(mediaDocuments.length > 0 ? { attachmentTexts: mediaDocuments } : {}),
    });
    const analysisAgent =
      this.options.config.opencode.analysisAgent ?? this.options.config.opencode.agent;
    const raw = await this.options.sessionManager.runWorker(
      {
        platform: task.platform,
        chatId: task.chatId,
        directory: worktree,
        title: `${this.options.config.opencode.sessionTitlePrefix}:worker:analysis:${task.chatId}`,
        role: "analysis",
        taskId: task.id,
        ...(onSession ? { onSession } : {}),
        ...(this.options.conversationIdFor?.(task.platform, task.chatId)
          ? { conversationId: this.options.conversationIdFor(task.platform, task.chatId) }
          : {}),
        permission: this.options.readOnlyPermission,
        ...(analysisAgent ? { agent: analysisAgent } : {}),
        ...(this.options.config.analysis.model
          ? { model: this.options.config.analysis.model }
          : {}),
      },
      prompt,
      signal,
      attachments,
    );
    return parseAnalysis(raw, task, workspaceProjects?.[0]?.name ?? "workspace");
  }

  private async verifyAnalysis(
    task: TaskRecord,
    analysis: TaskAnalysis,
    signal?: AbortSignal,
  ): Promise<AnalysisVerification> {
    const context = await this.options.contextService.analysisContext(task);
    const base = deterministicVerification(analysis, context.corpus);
    if (
      !this.options.config.subagents.enabled ||
      !this.options.config.subagents.reviewer
    ) {
      return base;
    }
    const directory = await this.analysisDirectory(task);
    const project = await this.options.resolveProject(task.chatId);
    const title = `${this.options.config.opencode.sessionTitlePrefix}:analysis-check:${task.chatId}`;
    try {
      const raw = await this.options.sessionManager.runWorker(
        {
          platform: task.platform,
          chatId: task.chatId,
          directory,
          title,
          role: "review",
          taskId: task.id,
          ...(this.options.conversationIdFor?.(task.platform, task.chatId)
            ? { conversationId: this.options.conversationIdFor(task.platform, task.chatId) }
            : {}),
          permission: this.options.readOnlyPermission,
          agent: this.options.config.subagents.reviewer,
        },
        [
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
            writableProjects: project.writableProjects ?? [],
            readonlyProjects: project.referenceProjects ?? [],
          }),
          "分析：",
          JSON.stringify(analysis),
        ].join("\n"),
        signal,
      );
      return mergeVerification(base, parseVerification(raw));
    } catch (error) {
      this.options.logger.warn("analysis verification failed; keeping deterministic checks", {
        taskId: task.id,
        error: toErrorMessage(error),
      });
      return base;
    }
  }

  private async analysisDirectory(task: TaskRecord): Promise<string> {
    const workspaceConfig = this.options.config.platforms.feishu.groups.find(
      (group) => group.chatId === task.chatId,
    )?.workspace;
    if (workspaceConfig) {
      return (await this.options.resolveProject(task.chatId)).worktree;
    }
    const repo = this.options.config.repos[0];
    if (repo) return repo.path;
    const project = await this.options.resolveProject(task.chatId);
    return project.worktree;
  }

  private missingProjectAnalysis(task: TaskRecord): TaskAnalysis {
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
      openQuestions: ["未定位到当前工作空间，请配置 group.workspace 或 project.worktree"],
      acceptanceCriteria: [],
      model: "none",
      createdAt: Date.now(),
      planHash: "",
    };
  }
}
