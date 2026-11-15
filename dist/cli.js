#!/usr/bin/env node
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, resolveLogFile, resolveStateDir } from "./core/config.js";
import { createLogger } from "./core/logger.js";
import { FeishuAdapter } from "./adapters/feishu/adapter.js";
import { FeishuEventSource } from "./adapters/feishu/events.js";
import { HybridFeishuAdapter } from "./adapters/feishu/hybrid.js";
import { HttpOpenCodeBridge } from "./core/opencode.js";
import { ProxyRuntime } from "./core/runtime.js";
import { toErrorMessage } from "./core/util.js";
import { acquireInstanceLock, releaseInstanceLock } from "./core/instance-lock.js";
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
async function main() {
    const logger = createLogger({ scope: "cli" });
    const command = process.argv[2] ?? "start";
    if (command === "agents") {
        await installAgents();
        return;
    }
    if (command === "version" || command === "--version" || command === "-v") {
        process.stdout.write("0.1.0\n");
        return;
    }
    if (command !== "start") {
        process.stderr.write([
            "usage:",
            "  atme-proxy start           start the daemon",
            "  atme-proxy agents          install bundled agents to ~/.config/opencode/agents",
            "  atme-proxy version         print version",
            "",
        ].join("\n"));
        process.exitCode = 1;
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