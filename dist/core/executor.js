import { execFile } from "node:child_process";
import { mkdir, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { createLogger } from "./logger.js";
import { toErrorMessage, truncate } from "./util.js";
const execFileAsync = promisify(execFile);
export class GitExecutor {
    options;
    logger;
    constructor(options) {
        this.options = options;
        this.logger = options.logger ?? createLogger({ scope: "executor" });
    }
    async prepare(repo, taskId) {
        const repoRoot = await realpath(repo.path);
        const info = await stat(repoRoot);
        if (!info.isDirectory())
            throw new Error(`repo path is not a directory: ${repoRoot}`);
        const topLevel = (await this.git(repoRoot, ["rev-parse", "--show-toplevel"])).trim();
        if ((await realpath(topLevel)) !== repoRoot) {
            throw new Error(`repo path is not the git top-level: ${repoRoot}`);
        }
        const baseCommit = (await this.git(repoRoot, ["rev-parse", repo.defaultBranch])).trim();
        const safeTaskId = taskId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
        const branch = `atme/${safeTaskId}-${Date.now().toString(36)}`;
        const worktreePath = join(this.options.worktreeRoot, safeTaskId, Date.now().toString(36));
        await mkdir(join(this.options.worktreeRoot, safeTaskId), { recursive: true });
        await this.git(repoRoot, [
            "worktree",
            "add",
            "-b",
            branch,
            worktreePath,
            repo.defaultBranch,
        ]);
        this.logger.info("worktree created", { repoId: repo.id, branch, worktreePath, baseCommit });
        return { path: worktreePath, branch, baseCommit };
    }
    async runConfiguredCommands(repo, worktree) {
        const commands = [...repo.lintCommand, ...repo.testCommand];
        if (commands.length === 0) {
            return { passed: true, summary: "no test/lint command configured" };
        }
        for (const command of commands) {
            if (!Array.isArray(command) || command.length === 0)
                continue;
            const [file, ...args] = command;
            if (!file)
                continue;
            try {
                const result = await execFileAsync(file, args, {
                    cwd: worktree.path,
                    timeout: this.options.timeoutMs,
                    maxBuffer: 4 * 1024 * 1024,
                    env: {
                        ...process.env,
                        CI: "1",
                        GIT_TERMINAL_PROMPT: "0",
                    },
                });
                this.logger.info("command passed", {
                    command: command.join(" "),
                    stdout: truncate(result.stdout ?? "", 500),
                });
            }
            catch (error) {
                const stdout = extractOutput(error, "stdout");
                const stderr = extractOutput(error, "stderr");
                return {
                    passed: false,
                    summary: truncate(`command failed: ${command.join(" ")}\n${stderr || stdout || toErrorMessage(error)}`, 1500),
                };
            }
        }
        return { passed: true, summary: "all commands passed" };
    }
    async diffStat(worktree) {
        const stat = await this.git(worktree.path, ["diff", "--stat"]);
        const status = await this.git(worktree.path, ["status", "--porcelain"]);
        return truncate(`${stat}\n${status}`.trim(), 2000);
    }
    async commitState(worktree) {
        return (await this.git(worktree.path, ["rev-parse", "HEAD"])).trim();
    }
    async cleanup(worktree) {
        try {
            await this.git(dirname(worktree.path), ["worktree", "remove", "--force", worktree.path]);
            await this.git(dirname(worktree.path), ["branch", "-D", worktree.branch]);
        }
        catch (error) {
            this.logger.warn("worktree cleanup failed", {
                worktree: worktree.path,
                branch: worktree.branch,
                error: toErrorMessage(error),
            });
        }
    }
    async git(cwd, args) {
        const result = await execFileAsync("git", ["-C", cwd, ...args], {
            timeout: this.options.timeoutMs,
            maxBuffer: 4 * 1024 * 1024,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        });
        return result.stdout ?? "";
    }
}
function extractOutput(error, key) {
    if (typeof error === "object" && error !== null && key in error) {
        const value = error[key];
        if (typeof value === "string")
            return value;
        if (Buffer.isBuffer(value))
            return value.toString("utf8");
    }
    return "";
}
//# sourceMappingURL=executor.js.map