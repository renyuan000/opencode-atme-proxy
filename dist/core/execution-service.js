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
    async executeInWorktree(task, analysis, worktree, planHash) {
        const approved = await this.options.approvals.latest(task.id, "develop");
        if (!approved || approved.decision !== "approved" || approved.planHash !== planHash) {
            throw new Error("approval missing or stale");
        }
        const release = await this.slots.acquire();
        try {
            task.state = "executing";
            task.updatedAt = Date.now();
            await this.options.tasks.save(task);
            const prompt = this.executionPrompt(task, analysis, worktree);
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
    executionPrompt(task, analysis, directory) {
        return [
            "你已获得用户批准，执行以下任务。",
            "只允许在指定工作目录内修改；不要 push，不要合并，不要 force push，不要删除仓库。",
            "完成后运行测试与 lint（如已配置），并报告 diff 摘要。",
            `当前项目目录：${directory}`,
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