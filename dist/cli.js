#!/usr/bin/env node
import { config as loadDotenv } from "dotenv";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfigPath, loadConfig, resolveLogFile, resolveStateDir, } from "./core/config.js";
import { createLogger } from "./core/logger.js";
import { FeishuAdapter } from "./adapters/feishu/adapter.js";
import { FeishuEventSource } from "./adapters/feishu/events.js";
import { HybridFeishuAdapter } from "./adapters/feishu/hybrid.js";
import { HttpOpenCodeBridge } from "./core/opencode.js";
import { ProxyRuntime } from "./core/runtime.js";
import { toErrorMessage } from "./core/util.js";
import { acquireInstanceLock, releaseInstanceLock } from "./core/instance-lock.js";
import { runSetup, runDoctor } from "./setup/wizard.js";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
export async function startDaemon(options = {}) {
    const loaded = await loadConfig({ path: options.configPath });
    const logger = createLogger({
        scope: "app",
        level: loaded.config.app.logLevel,
        ...(resolveLogFile(loaded.config) ? { file: resolveLogFile(loaded.config) } : {}),
    });
    const stateDir = resolveStateDir(loaded.config);
    const lockPath = join(stateDir, "instance.lock");
    await acquireInstanceLock(lockPath, logger);
    const appSecret = loaded.secrets.appSecret;
    if (!appSecret)
        throw new Error("Feishu app secret is required");
    const runtimeLogger = logger.child("runtime");
    const adapter = new FeishuAdapter({
        config: loaded.config.platforms.feishu,
        appSecret,
        logger: logger.child("feishu"),
    });
    const events = new FeishuEventSource({
        config: loaded.config.platforms.feishu,
        appSecret,
        adapter,
        logger: logger.child("feishu.events"),
    });
    const hybrid = new HybridFeishuAdapter(adapter, events);
    const bridge = new HttpOpenCodeBridge({
        baseUrl: loaded.config.opencode.baseUrl,
        ...(loaded.secrets.opencodePassword
            ? { password: loaded.secrets.opencodePassword }
            : {}),
        logger: logger.child("opencode"),
    });
    const runtime = new ProxyRuntime({
        platform: hybrid,
        bridge,
        loaded,
        logger: runtimeLogger,
    });
    await runtime.start();
    return {
        async stop() {
            await runtime.stop();
            await releaseInstanceLock(lockPath, logger);
        },
    };
}
async function installAgents() {
    const source = join(dirname(fileURLToPath(import.meta.url)), "..", ".opencode", "agents");
    const target = join(homedir(), ".config", "opencode", "agents");
    await mkdir(target, { recursive: true });
    for (const name of ["atme-analyst.md", "atme-executor.md", "atme-reviewer.md"]) {
        await copyFile(join(source, name), join(target, name));
    }
    process.stdout.write(`agents installed to ${target}\n`);
}
function bootstrapEnv() {
    const configIndex = process.argv.indexOf("--config");
    const explicit = configIndex >= 0 ? process.argv[configIndex + 1] : undefined;
    const configPath = explicit ?? process.env.ATME_CONFIG ?? defaultConfigPath();
    loadDotenv({ path: join(dirname(configPath), ".env"), quiet: true });
    loadDotenv({ quiet: true });
}
async function main() {
    bootstrapEnv();
    const logger = createLogger({ scope: "cli" });
    const command = process.argv[2] ?? "help";
    if (command === "agents") {
        await installAgents();
        return;
    }
    if (command === "setup") {
        await runSetup({
            ...(process.argv.includes("--config")
                ? { configPath: process.argv[process.argv.indexOf("--config") + 1] }
                : {}),
            nonInteractive: process.argv.includes("--yes"),
        });
        return;
    }
    if (command === "doctor") {
        const checks = await runDoctor(process.argv.includes("--config")
            ? process.argv[process.argv.indexOf("--config") + 1]
            : undefined);
        let failed = 0;
        for (const check of checks) {
            process.stdout.write(`${check.ok ? "✅" : "❌"} ${check.label}${check.detail ? ` — ${check.detail}` : ""}\n`);
            if (!check.ok) {
                failed++;
                if (check.fix)
                    process.stdout.write(`   fix: ${check.fix}\n`);
            }
        }
        if (failed > 0)
            process.exitCode = 1;
        return;
    }
    if (command === "status") {
        const stateDir = process.env.ATME_STATE_DIR ?? join(homedir(), ".local", "state", "opencode-atme-proxy");
        const lockPath = join(stateDir, "instance.lock");
        if (!existsSync(lockPath)) {
            process.stdout.write("stopped\n");
            process.exitCode = 1;
            return;
        }
        const raw = JSON.parse(readFileSync(lockPath, "utf8"));
        try {
            process.kill(raw.pid ?? 0, 0);
            process.stdout.write(`running (pid ${raw.pid})\n`);
        }
        catch {
            process.stdout.write(`stale lock (pid ${raw.pid})\n`);
            process.exitCode = 1;
        }
        return;
    }
    if (command === "stop") {
        const stateDir = process.env.ATME_STATE_DIR ?? join(homedir(), ".local", "state", "opencode-atme-proxy");
        const lockPath = join(stateDir, "instance.lock");
        if (!existsSync(lockPath)) {
            process.stdout.write("not running\n");
            return;
        }
        const raw = JSON.parse(readFileSync(lockPath, "utf8"));
        if (raw.pid) {
            try {
                process.kill(raw.pid, "SIGTERM");
                process.stdout.write(`sent SIGTERM to ${raw.pid}\n`);
            }
            catch (error) {
                process.stderr.write(`failed to stop: ${toErrorMessage(error)}\n`);
            }
        }
        try {
            unlinkSync(lockPath);
        }
        catch { }
        return;
    }
    if (command === "version" || command === "--version" || command === "-v") {
        process.stdout.write("0.1.0\n");
        return;
    }
    if (command !== "start") {
        process.stdout.write([
            "usage:",
            "  atme-proxy setup            interactive configuration wizard",
            "  atme-proxy doctor           check config, credentials, OpenCode and project",
            "  atme-proxy agents           install bundled agents to ~/.config/opencode/agents",
            "  atme-proxy status           show daemon status",
            "  atme-proxy stop             stop the daemon",
            "  atme-proxy start            start the daemon",
            "  atme-proxy version          print version",
            "",
        ].join("\n"));
        if (command !== "help" && command !== "--help" && command !== "-h") {
            process.exitCode = 1;
        }
        return;
    }
    let handle;
    try {
        handle = await startDaemon();
    }
    catch (error) {
        logger.error("failed to start", { error: toErrorMessage(error) });
        throw error;
    }
    const shutdown = async (signal) => {
        logger.info("shutting down", { signal, pid: process.pid });
        try {
            await handle?.stop();
        }
        catch (error) {
            logger.error("shutdown failed", { error: toErrorMessage(error) });
        }
        finally {
            process.exit(0);
        }
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
    logger.info("daemon running", { pid: process.pid, runId: randomUUID() });
}
function isEntryPoint() {
    const entry = process.argv[1];
    if (!entry)
        return false;
    try {
        return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
    }
    catch {
        return false;
    }
}
if (isEntryPoint()) {
    void main().catch((error) => {
        process.stderr.write(`${toErrorMessage(error)}\n`);
        process.exit(1);
    });
}
//# sourceMappingURL=cli.js.map