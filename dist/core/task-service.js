import { join } from "node:path";
import { deterministicVerification, mergeVerification, parseVerification, } from "./analysis-verify.js";
import { parseAnalysis } from "./analysis.js";
import { buildAnalysisPrompt } from "./prompts.js";
import { makeDedupKey } from "./relevance.js";
import { sha256, toErrorMessage, truncate, writeJsonAtomic } from "./util.js";
export class TaskService {
    options;
    constructor(options) {
        this.options = options;
    }
    async analyzeTask(task) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error("analysis timed out")), this.options.config.concurrency.analysisTimeoutMs);
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
        await this.options.tasks.save(task);
        const stateDir = this.options.stateDirFor?.(task.chatId) ?? this.options.stateDir;
        await writeJsonAtomic(join(stateDir, "analyses", task.id, `${analysis.version}.json`), analysis);
        await writeJsonAtomic(join(stateDir, "analyses", task.id, "index.json"), { version: analysis.version });
        const workspaceDir = this.options.workspaceDirFor?.(task.chatId);
        if (workspaceDir) {
            await writeJsonAtomic(join(workspaceDir, "analysis", task.id, `${analysis.version}.json`), analysis);
            await writeJsonAtomic(join(workspaceDir, "analysis", task.id, "index.json"), { version: analysis.version });
        }
        this.rememberTaskOutcome(task, analysis);
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
            await this.options.sendToApprover(`任务需要补充信息：${task.title}\n${analysis.openQuestions
                .map((question) => `- ${question}`)
                .join("\n")}`);
            return;
        }
        await this.options.sendApproval(task, analysis);
    }
    async ensureTask(message, classification, source, options) {
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
        const task = {
            id: `task_${sha256(`${dedupKey}:${message.messageId}`).slice(0, 12)}`,
            platform: message.platform,
            chatId: message.chat.id,
            ...(this.options.conversationIdFor?.(message.platform, message.chat.id)
                ? {
                    conversationId: this.options.conversationIdFor(message.platform, message.chat.id),
                }
                : {}),
            ...(message.chat.name ? { chatName: message.chat.name } : {}),
            messageIds: message.messageIds ?? [message.messageId],
            source,
            requester: message.sender,
            title,
            excerpt: truncate(message.text, 500),
            ...(message.attachments?.length ? { attachments: message.attachments } : {}),
            ...(taskHint?.project ? { project: taskHint.project } : {}),
            ...(taskHint?.deadline ? { deadline: taskHint.deadline } : {}),
            keywords: this.options.config.filter.profile.keywords.filter((keyword) => message.text.includes(keyword)),
            relevance: {
                reason: classification?.reason ?? "mentioned",
                confidence: classification?.confidence ?? 1,
            },
            dedupKey,
            state: "analyzing",
            createdAt: now,
            updatedAt: now,
        };
        await this.options.tasks.save(task);
        await this.options.audit.append({
            actor: { system: true },
            action: "task_created",
            taskId: task.id,
            details: { source, messageId: message.messageId },
        });
        const autoAnalyze = options?.autoAnalyze ?? this.options.config.policy.autoAnalyzeTasks;
        if (!autoAnalyze) {
            task.state = "needs_info";
            task.updatedAt = Date.now();
            await this.options.tasks.save(task);
            await this.options.sendToApprover(`已记录候选任务，暂不自动分析：${task.title}\n如需分析，回复 /分析 ${task.id}`);
            return task;
        }
        this.options.startAnalysis(task);
        return task;
    }
    rememberTaskOutcome(task, analysis) {
        if (!this.options.config.memory.enabled || !this.options.config.memory.extract)
            return;
        if (!this.options.config.memory.autoExtractFromAnalysis)
            return;
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
    async buildAnalysis(task, signal) {
        const attachments = (await this.options.loadAttachments?.(task)) ?? [];
        const workspaceConfig = this.options.config.platforms.feishu.groups.find((group) => group.chatId === task.chatId)?.workspace;
        if (workspaceConfig) {
            const project = await this.options.resolveProject(task.chatId);
            if (!project.resolved) {
                return this.missingProjectAnalysis(task);
            }
            return this.buildAnalysisInWorktree(task, project.worktree, signal, project.workspaceProjects, project.workspaceDocs, attachments);
        }
        const repo = this.options.config.repos[0];
        if (!repo) {
            const project = await this.options.resolveProject(task.chatId);
            if (!project.resolved) {
                return this.missingProjectAnalysis(task);
            }
            return this.buildAnalysisInWorktree(task, project.worktree, signal, undefined, undefined, attachments);
        }
        const ctx = await this.options.contextService.analysisContext(task);
        const prompt = buildAnalysisPrompt({
            task,
            repositoryIds: this.options.config.repos.map((item) => item.id),
            directory: repo.path,
            context: ctx,
        });
        const analysisAgent = this.options.config.opencode.analysisAgent ?? this.options.config.opencode.agent;
        const raw = await this.options.sessionManager.runWorker({
            platform: task.platform,
            chatId: task.chatId,
            directory: repo.path,
            title: `${this.options.config.opencode.sessionTitlePrefix}:worker:analysis:${task.chatId}`,
            role: "analysis",
            ...(this.options.conversationIdFor?.(task.platform, task.chatId)
                ? { conversationId: this.options.conversationIdFor(task.platform, task.chatId) }
                : {}),
            permission: this.options.readOnlyPermission,
            ...(analysisAgent ? { agent: analysisAgent } : {}),
            ...(this.options.config.analysis.model
                ? { model: this.options.config.analysis.model }
                : {}),
        }, prompt, signal, attachments);
        return parseAnalysis(raw, task, repo.id);
    }
    async buildAnalysisInWorktree(task, worktree, signal, workspaceProjects, workspaceDocs, attachments = []) {
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
            ...(task.attachments?.length
                ? { attachmentNames: task.attachments.map((item) => item.name ?? item.kind) }
                : {}),
        });
        const analysisAgent = this.options.config.opencode.analysisAgent ?? this.options.config.opencode.agent;
        const raw = await this.options.sessionManager.runWorker({
            platform: task.platform,
            chatId: task.chatId,
            directory: worktree,
            title: `${this.options.config.opencode.sessionTitlePrefix}:worker:analysis:${task.chatId}`,
            role: "analysis",
            ...(this.options.conversationIdFor?.(task.platform, task.chatId)
                ? { conversationId: this.options.conversationIdFor(task.platform, task.chatId) }
                : {}),
            permission: this.options.readOnlyPermission,
            ...(analysisAgent ? { agent: analysisAgent } : {}),
            ...(this.options.config.analysis.model
                ? { model: this.options.config.analysis.model }
                : {}),
        }, prompt, signal, attachments);
        return parseAnalysis(raw, task, workspaceProjects?.[0]?.name ?? "workspace");
    }
    async verifyAnalysis(task, analysis, signal) {
        const context = await this.options.contextService.analysisContext(task);
        const base = deterministicVerification(analysis, context.corpus);
        if (!this.options.config.subagents.enabled ||
            !this.options.config.subagents.reviewer) {
            return base;
        }
        const directory = await this.analysisDirectory(task);
        const title = `${this.options.config.opencode.sessionTitlePrefix}:worker:review:${task.chatId}`;
        try {
            const raw = await this.options.sessionManager.runWorker({
                platform: task.platform,
                chatId: task.chatId,
                directory,
                title,
                role: "review",
                ...(this.options.conversationIdFor?.(task.platform, task.chatId)
                    ? { conversationId: this.options.conversationIdFor(task.platform, task.chatId) }
                    : {}),
                permission: this.options.readOnlyPermission,
                agent: this.options.config.subagents.reviewer,
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
            this.options.logger.warn("analysis verification failed; keeping deterministic checks", {
                taskId: task.id,
                error: toErrorMessage(error),
            });
            return base;
        }
    }
    async analysisDirectory(task) {
        const workspaceConfig = this.options.config.platforms.feishu.groups.find((group) => group.chatId === task.chatId)?.workspace;
        if (workspaceConfig) {
            return (await this.options.resolveProject(task.chatId)).worktree;
        }
        const repo = this.options.config.repos[0];
        if (repo)
            return repo.path;
        const project = await this.options.resolveProject(task.chatId);
        return project.worktree;
    }
    missingProjectAnalysis(task) {
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
//# sourceMappingURL=task-service.js.map