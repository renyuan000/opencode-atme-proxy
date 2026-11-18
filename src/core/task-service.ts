import { join } from "node:path";
import type { AppConfig } from "./config.js";
import type { AuditLog } from "./audit.js";
import type { ContextService } from "./context-service.js";
import type { Logger } from "./logger.js";
import type { SessionManager, SessionPermission } from "./session-manager.js";
import type { TaskStore } from "./task-store.js";
import type {
  AnalysisVerification,
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
import { toErrorMessage, writeJsonAtomic } from "./util.js";

export interface TaskServiceOptions {
  config: AppConfig;
  stateDir: string;
  tasks: TaskStore;
  audit: AuditLog;
  contextService: ContextService;
  sessionManager: SessionManager;
  logger: Logger;
  readOnlyPermission: SessionPermission[];
  resolveProject(chatId: string): Promise<{ worktree: string; resolved: boolean }>;
  rememberOutcome(task: TaskRecord, analysis: TaskAnalysis): void;
  sendToApprover(text: string): Promise<boolean>;
  sendApproval(task: TaskRecord, analysis: TaskAnalysis): Promise<void>;
}

export class TaskService {
  constructor(private readonly options: TaskServiceOptions) {}

  async analyzeTask(task: TaskRecord): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("analysis timed out")),
      this.options.config.concurrency.analysisTimeoutMs,
    );
    let analysis: TaskAnalysis;
    let verification: AnalysisVerification | undefined;
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
    } finally {
      clearTimeout(timer);
    }
    await this.options.tasks.save(task);
    await writeJsonAtomic(
      join(this.options.stateDir, "analyses", task.id, `${analysis.version}.json`),
      analysis,
    );
    await writeJsonAtomic(
      join(this.options.stateDir, "analyses", task.id, "index.json"),
      { version: analysis.version },
    );
    this.options.rememberOutcome(task, analysis);
    task.state = analysis.needsInfo ? "needs_info" : "awaiting_approval";
    task.updatedAt = Date.now();
    await this.options.tasks.save(task);
    await this.options.audit.append({
      actor: { system: true },
      action: "analysis_verified",
      taskId: task.id,
      details: {
        drift: verification?.drift ?? "unknown",
        unverified: verification?.unverifiedIdentifiers.length ?? 0,
      },
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

  private async buildAnalysis(
    task: TaskRecord,
    signal?: AbortSignal,
  ): Promise<TaskAnalysis> {
    const repo = this.options.config.repos[0];
    if (!repo) {
      const project = await this.options.resolveProject(task.chatId);
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
    const ctx = await this.options.contextService.analysisContext(task);
    const prompt = buildAnalysisPrompt({
      task,
      repositoryIds: this.options.config.repos.map((item) => item.id),
      directory: repo.path,
      context: ctx,
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
        permission: this.options.readOnlyPermission,
        ...(analysisAgent ? { agent: analysisAgent } : {}),
        ...(this.options.config.analysis.model
          ? { model: this.options.config.analysis.model }
          : {}),
      },
      prompt,
      signal,
    );
    return parseAnalysis(raw, task, repo.id);
  }

  private async buildAnalysisInWorktree(
    task: TaskRecord,
    worktree: string,
    signal?: AbortSignal,
  ): Promise<TaskAnalysis> {
    const ctx = await this.options.contextService.analysisContext(task);
    const prompt = buildAnalysisPrompt({
      task,
      repositoryIds: this.options.config.repos.map((item) => item.id),
      directory: worktree,
      context: ctx,
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
        permission: this.options.readOnlyPermission,
        ...(analysisAgent ? { agent: analysisAgent } : {}),
        ...(this.options.config.analysis.model
          ? { model: this.options.config.analysis.model }
          : {}),
      },
      prompt,
      signal,
    );
    return parseAnalysis(raw, task, "auto");
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
    const title = `${this.options.config.opencode.sessionTitlePrefix}:worker:review:${task.chatId}`;
    try {
      const raw = await this.options.sessionManager.runWorker(
        {
          platform: task.platform,
          chatId: task.chatId,
          directory,
          title,
          role: "review",
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
    const repo = this.options.config.repos[0];
    if (repo) return repo.path;
    const project = await this.options.resolveProject(task.chatId);
    return project.worktree;
  }
}
