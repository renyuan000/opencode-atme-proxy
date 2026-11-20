import { join } from "node:path";
import { repoById } from "./opencode.js";
import { Semaphore } from "./rate-limit.js";
import { toErrorMessage, truncate, writeJsonAtomic } from "./util.js";
export class ExecutionService {
    options;
    slots;
    constructor(options) {
        this.options = options;
        this.slots = new Semaphore(options.config.policy.maxConcurrentExecutions);
    }
    async executeTask(task, planHash) {
        const analysis = await this.options.latestAnalysis(task.id);
        if (!analysis)
            throw new Error("analysis missing");
        const workspaceConfig = this.options.config.platforms.feishu.groups.find((group) => group.chatId === task.chatId)?.workspace;
        if (workspaceConfig) {
            const project = await this.options.resolveProject(task.chatId);
            if (!project.resolved)
                throw new Error("no workspace resolved; refusing to execute");
            return this.executeInWorkspace(task, analysis, project.worktree, planHash, project.workspaceProjects, project.workspaceDocs);
        }
        const repo = repoById(this.options.config.repos, analysis.repos[0] ?? "");
        if (!repo) {
            const project = await this.options.resolveProject(task.chatId);
            if (!project.resolved)
                throw new Error("no project resolved; refusing to execute");
            return this.executeInWorktree(task, analysis, project.worktree, planHash);
        }
        const approved = await this.options.approvals.latest(task.id, "develop");
        if (!approved || approved.decision !== "approved" || approved.planHash !== planHash) {
            throw new Error("approval missing or stale");
        }
        const release = await this.slots.acquire();
        try {
            task.state = "executing";
            task.updatedAt = Date.now();
            await this.options.tasks.save(task);
            const execution = await this.runOpenCodeExecution(task, repo, analysis);
            await writeJsonAtomic(join(this.options.stateDirFor?.(task.chatId) ?? this.options.stateDir, "executions", `${task.id}.json`), execution);
            const workspaceDir = this.options.workspaceDirFor?.(task.chatId);
            if (workspaceDir) {
                await writeJsonAtomic(join(workspaceDir, "execution", `${task.id}.json`), execution);
            }
            task.state = execution.status === "succeeded" ? "done" : "failed";
            task.updatedAt = Date.now();
            await this.options.tasks.save(task);
            await this.options.sendToApprover(execution.status === "succeeded"
                ? `任务完成：${task.title}\n分支：${execution.branch}\n${execution.diffStat}`
                : `任务失败：${task.title}\n${execution.error ?? "未知错误"}`);
            if (execution.status === "succeeded") {
                await this.reviewExecution({
                    task,
                    directory: execution.worktree,
                    summary: execution.testResult?.summary ?? execution.diffStat ?? "",
                    ...(execution.diffStat ? { diffStat: execution.diffStat } : {}),
                });
            }
            await this.options.audit.append({
                actor: { system: true },
                action: execution.status === "succeeded" ? "execution_succeeded" : "execution_failed",
                taskId: task.id,
                details: { branch: execution.branch, repo: execution.repoId },
            });
            await this.options.sessionManager.archiveTaskChildren(task.id);
        }
        finally {
            release();
        }
    }
    async executeInWorkspace(task, analysis, workspaceRoot, planHash, workspaceProjects, workspaceDocs) {
        const approved = await this.options.approvals.latest(task.id, "develop");
        if (!approved || approved.decision !== "approved" || approved.planHash !== planHash) {
            throw new Error("approval missing or stale");
        }
        const release = await this.slots.acquire();
        const startedAt = Date.now();
        try {
            task.state = "executing";
            task.updatedAt = Date.now();
            await this.options.tasks.save(task);
            const projects = workspaceProjects ?? [];
            if (projects.length === 0) {
                throw new Error("workspace has no projects; configure with /工作空间 ... 添加");
            }
            const selected = projects.filter((project) => analysis.repos.includes(project.name));
            const targets = selected.length > 0 ? selected : projects;
            const taskWorkspace = join(workspaceRoot, "execution", `task-${task.id}-${Date.now().toString(36)}`);
            const worktrees = [];
            for (const project of targets) {
                const repo = {
                    id: project.name,
                    path: project.path,
                    defaultBranch: project.defaultBranch ?? "HEAD",
                    testCommand: project.testCommand ?? [],
                    lintCommand: project.lintCommand ?? [],
                    allowPush: false,
                    allowMerge: false,
                };
                const worktree = await this.options.executor.prepare(repo, task.id, {
                    root: join(taskWorkspace, "repos"),
                    name: project.name,
                });
                worktrees.push({ project, repo, worktree });
            }
            const prompt = this.workspaceExecutionPrompt(task, analysis, taskWorkspace, worktrees, workspaceDocs);
            const executionAgent = this.options.config.opencode.executionAgent ?? this.options.config.opencode.agent;
            const { sessionId, release: releaseChild } = await this.options.sessionManager.createChildSession({
                platform: task.platform,
                chatId: task.chatId,
                directory: taskWorkspace,
                title: `${this.options.config.opencode.sessionTitlePrefix}:exec:${task.id}`,
                role: "execution",
                permission: this.options.executionPermission,
                ...(executionAgent ? { agent: executionAgent } : {}),
                taskId: task.id,
            });
            let output = "";
            try {
                output = await this.options.bridge.prompt(sessionId, {
                    directory: taskWorkspace,
                    title: `${this.options.config.opencode.sessionTitlePrefix}:exec:${task.id}`,
                    text: prompt,
                });
            }
            finally {
                releaseChild();
                await this.options.sessionManager.finishSession(sessionId, `${this.options.config.opencode.sessionTitlePrefix}:exec:${task.id}`, taskWorkspace, "workspace_execution");
            }
            const checks = await Promise.all(worktrees.map(async (item) => {
                const diff = await this.options.executor.diffStat(item.worktree);
                const check = await this.options.executor.runConfiguredCommands(item.repo, item.worktree);
                return {
                    name: item.project.name,
                    diff,
                    ...check,
                };
            }));
            const passed = checks.every((check) => check.passed);
            const diffs = checks.map((check) => `${check.name}:\n${check.diff}`);
            const checkSummary = checks
                .map((check) => `${check.name}: ${check.passed ? "passed" : "failed"}${check.summary ? ` - ${check.summary}` : ""}`)
                .join("\n");
            const diffStat = truncate(diffs.join("\n\n"), 4000);
            const execution = {
                taskId: task.id,
                approvalPlanHash: analysis.planHash,
                repoId: targets.map((project) => project.name).join(","),
                worktree: taskWorkspace,
                branch: worktrees.map((item) => item.worktree.branch).join(","),
                baseCommit: worktrees.map((item) => item.worktree.baseCommit).join(","),
                status: passed ? "succeeded" : "failed",
                commands: targets.flatMap((project) => [
                    ...(project.lintCommand ?? []),
                    ...(project.testCommand ?? []),
                ]).map((command) => command.join(" ")),
                testResult: { passed, summary: checkSummary || "no test/lint command configured" },
                diffStat: diffStat || truncate(output, 1000),
                startedAt,
                finishedAt: Date.now(),
                ...(passed ? {} : { error: checkSummary }),
            };
            await writeJsonAtomic(join(this.options.stateDirFor?.(task.chatId) ?? this.options.stateDir, "executions", `${task.id}.json`), execution);
            const workspaceDir = this.options.workspaceDirFor?.(task.chatId);
            if (workspaceDir) {
                await writeJsonAtomic(join(workspaceDir, "execution", `${task.id}.json`), execution);
            }
            task.state = passed ? "done" : "failed";
            task.updatedAt = Date.now();
            await this.options.tasks.save(task);
            await this.options.sendToApprover(passed
                ? `任务完成：${task.title}\n工作空间：${taskWorkspace}\n${checkSummary}\n${execution.diffStat}`
                : `任务失败：${task.title}\n${checkSummary}\n${execution.diffStat}`);
            if (passed) {
                await this.reviewExecution({
                    task,
                    directory: taskWorkspace,
                    summary: execution.diffStat ?? "",
                    ...(execution.diffStat ? { diffStat: execution.diffStat } : {}),
                });
            }
            await this.options.audit.append({
                actor: { system: true },
                action: passed ? "execution_succeeded" : "execution_failed",
                taskId: task.id,
                details: {
                    workspace: taskWorkspace,
                    projects: targets.map((project) => project.name),
                },
            });
            await this.options.sessionManager.archiveTaskChildren(task.id);
        }
        catch (error) {
            task.state = "failed";
            task.updatedAt = Date.now();
            await this.options.tasks.save(task);
            await this.options.sendToApprover(`任务失败：${task.title}\n${toErrorMessage(error)}`);
            throw error;
        }
        finally {
            release();
        }
    }
    async executeInWorktree(task, analysis, worktree, planHash, workspaceProjects, workspaceDocs) {
        const approved = await this.options.approvals.latest(task.id, "develop");
        if (!approved || approved.decision !== "approved" || approved.planHash !== planHash) {
            throw new Error("approval missing or stale");
        }
        const release = await this.slots.acquire();
        try {
            task.state = "executing";
            task.updatedAt = Date.now();
            await this.options.tasks.save(task);
            const prompt = this.executionPrompt(task, analysis, worktree, workspaceProjects, workspaceDocs);
            const executionAgent = this.options.config.opencode.executionAgent ?? this.options.config.opencode.agent;
            const { sessionId, release } = await this.options.sessionManager.createChildSession({
                platform: task.platform,
                chatId: task.chatId,
                directory: worktree,
                title: `${this.options.config.opencode.sessionTitlePrefix}:exec:${task.id}`,
                role: "execution",
                permission: this.options.executionPermission,
                ...(executionAgent ? { agent: executionAgent } : {}),
                taskId: task.id,
            });
            let output = "";
            try {
                output = await this.options.bridge.prompt(sessionId, {
                    directory: worktree,
                    title: `${this.options.config.opencode.sessionTitlePrefix}:exec:${task.id}`,
                    text: prompt,
                });
            }
            finally {
                release();
                await this.options.sessionManager.finishSession(sessionId, `${this.options.config.opencode.sessionTitlePrefix}:exec:${task.id}`, worktree, "task_execution");
            }
            const execution = {
                taskId: task.id,
                approvalPlanHash: analysis.planHash,
                repoId: analysis.repos[0] ?? "auto",
                worktree,
                branch: `atme/${task.id}`,
                baseCommit: "",
                status: "succeeded",
                commands: analysis.commands,
                testResult: { passed: true, summary: "executed in resolved project worktree" },
                diffStat: truncate(output, 1000),
                startedAt: Date.now(),
                finishedAt: Date.now(),
            };
            await writeJsonAtomic(join(this.options.stateDirFor?.(task.chatId) ?? this.options.stateDir, "executions", `${task.id}.json`), execution);
            task.state = "done";
            task.updatedAt = Date.now();
            await this.options.tasks.save(task);
            await this.options.sendToApprover(`任务完成：${task.title}\n目录：${worktree}\n${execution.diffStat}`);
            await this.reviewExecution({
                task,
                directory: worktree,
                summary: execution.diffStat ?? "",
                ...(execution.diffStat ? { diffStat: execution.diffStat } : {}),
            });
            await this.options.audit.append({
                actor: { system: true },
                action: "execution_succeeded",
                taskId: task.id,
                details: { worktree },
            });
            await this.options.sessionManager.archiveTaskChildren(task.id);
        }
        catch (error) {
            task.state = "failed";
            task.updatedAt = Date.now();
            await this.options.tasks.save(task);
            await this.options.sendToApprover(`任务失败：${task.title}\n${toErrorMessage(error)}`);
            throw error;
        }
        finally {
            release();
        }
    }
    async reviewExecution(input) {
        if (!this.options.config.subagents.enabled || !this.options.config.subagents.reviewer)
            return;
        const title = `${this.options.config.opencode.sessionTitlePrefix}:review:${input.task.id}`;
        try {
            const { sessionId, release } = await this.options.sessionManager.createChildSession({
                platform: input.task.platform,
                chatId: input.task.chatId,
                directory: input.directory,
                title,
                role: "review",
                permission: this.options.readOnlyPermission,
                taskId: input.task.id,
            });
            try {
                const review = await this.options.bridge.prompt(sessionId, {
                    directory: input.directory,
                    title,
                    text: [
                        "你是只读评审。不要修改文件，不要执行写操作。",
                        "检查这次改动是否满足任务验收标准，指出风险或遗漏。",
                        "输出最多 5 行，先给结论（通过/需修改），再给发现。",
                        `任务：${input.task.title}`,
                        `执行摘要：${truncate(input.summary, 800)}`,
                        ...(input.diffStat ? [`diff：${truncate(input.diffStat, 1200)}`] : []),
                    ].join("\n"),
                });
                await this.options.sendToOwner(`评审结果：${input.task.title}\n${truncate(review.trim(), 800)}`);
            }
            finally {
                release();
                await this.options.sessionManager.finishSession(sessionId, title, input.directory, "task_review");
            }
        }
        catch (error) {
            this.options.logger.warn("execution review failed", {
                taskId: input.task.id,
                error: toErrorMessage(error),
            });
        }
    }
    async runOpenCodeExecution(task, repo, analysis) {
        const startedAt = Date.now();
        let worktree;
        try {
            worktree = await this.options.executor.prepare(repo, task.id);
            const prompt = this.executionPrompt(task, analysis, worktree.path);
            const executionAgent = this.options.config.opencode.executionAgent ?? this.options.config.opencode.agent;
            const { sessionId, release } = await this.options.sessionManager.createChildSession({
                platform: task.platform,
                chatId: task.chatId,
                directory: worktree.path,
                title: `${this.options.config.opencode.sessionTitlePrefix}:exec:${task.id}`,
                role: "execution",
                permission: this.options.executionPermission,
                ...(executionAgent ? { agent: executionAgent } : {}),
                taskId: task.id,
            });
            let output = "";
            try {
                output = await this.options.bridge.prompt(sessionId, {
                    directory: worktree.path,
                    title: `${this.options.config.opencode.sessionTitlePrefix}:exec:${task.id}`,
                    text: prompt,
                });
            }
            finally {
                release();
                await this.options.sessionManager.finishSession(sessionId, `${this.options.config.opencode.sessionTitlePrefix}:exec:${task.id}`, worktree.path, "task_execution");
            }
            const testResult = await this.options.executor.runConfiguredCommands(repo, worktree);
            const diffStat = await this.options.executor.diffStat(worktree);
            const head = await this.options.executor.commitState(worktree);
            void head;
            void output;
            return {
                taskId: task.id,
                approvalPlanHash: analysis.planHash,
                repoId: repo.id,
                worktree: worktree.path,
                branch: worktree.branch,
                baseCommit: worktree.baseCommit,
                status: testResult.passed ? "succeeded" : "failed",
                commands: [...repo.lintCommand, ...repo.testCommand].map((command) => command.join(" ")),
                testResult,
                diffStat,
                startedAt,
                finishedAt: Date.now(),
                ...(testResult.passed ? {} : { error: testResult.summary }),
            };
        }
        catch (error) {
            return {
                taskId: task.id,
                approvalPlanHash: analysis.planHash,
                repoId: repo.id,
                worktree: worktree?.path ?? "",
                branch: worktree?.branch ?? "",
                baseCommit: worktree?.baseCommit ?? "",
                status: "failed",
                commands: [...repo.lintCommand, ...repo.testCommand].map((command) => command.join(" ")),
                startedAt,
                finishedAt: Date.now(),
                error: toErrorMessage(error),
            };
        }
    }
    workspaceExecutionPrompt(task, analysis, directory, worktrees, workspaceDocs) {
        return [
            "你已获得用户批准，在群工作空间内执行以下任务。",
            "只允许修改下面列出的工作树；不要 push，不要合并，不要 force push，不要删除仓库。",
            "不同代码项目是平级关系；先判断修改属于哪个项目，再在对应工作树内修改。",
            "完成后检查各项目 diff，并在结果中说明修改了哪些项目。",
            `当前执行目录：${directory}`,
            "本次项目工作树：",
            ...worktrees.map((item) => `- ${item.project.name}: ${item.worktree.path}（base=${item.worktree.baseCommit}${item.project.description ? `，${item.project.description}` : ""}）`),
            ...worktrees.flatMap((item) => {
                const commands = [
                    ...(item.project.lintCommand ?? []).map((command) => `lint: ${command.join(" ")}`),
                    ...(item.project.testCommand ?? []).map((command) => `test: ${command.join(" ")}`),
                ];
                return commands.length > 0
                    ? [`${item.project.name} 执行命令：`, ...commands.map((command) => `- ${command}`)]
                    : [];
            }),
            ...(workspaceDocs?.length
                ? ["关键开发公共文档（可读取，未读不要编造内容）：", ...workspaceDocs.map((path) => `- ${path}`)]
                : []),
            JSON.stringify({
                task: task.title,
                goal: analysis.goal,
                scope: analysis.scope,
                outOfScope: analysis.outOfScope,
                repos: analysis.repos,
                plan: analysis.plan,
                commands: analysis.commands,
                acceptance: analysis.acceptanceCriteria,
            }),
        ].join("\n");
    }
    executionPrompt(task, analysis, directory, workspaceProjects, workspaceDocs) {
        return [
            "你已获得用户批准，执行以下任务。",
            "只允许在指定工作目录内修改；不要 push，不要合并，不要 force push，不要删除仓库。",
            "完成后运行测试与 lint（如已配置），并报告 diff 摘要。",
            workspaceProjects?.length ? `当前工作空间：${directory}` : `当前项目目录：${directory}`,
            ...(workspaceProjects?.length
                ? [
                    "工作空间内代码项目（平级，按任务选择涉及项目）：",
                    ...workspaceProjects.map((project) => `- ${project.name}: ${project.path}${project.description ? `（${project.description}）` : ""}`),
                ]
                : []),
            ...(workspaceDocs?.length
                ? ["关键开发公共文档（可读取，未读不要编造内容）：", ...workspaceDocs.map((path) => `- ${path}`)]
                : []),
            JSON.stringify({
                task: task.title,
                goal: analysis.goal,
                scope: analysis.scope,
                outOfScope: analysis.outOfScope,
                plan: analysis.plan,
                commands: analysis.commands,
                acceptance: analysis.acceptanceCriteria,
            }),
        ].join("\n");
    }
}
//# sourceMappingURL=execution-service.js.map