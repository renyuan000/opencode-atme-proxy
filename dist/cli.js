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
import * as Lark from "@larksuiteoapi/node-sdk";
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
    const health = await bridge.healthCheck?.();
    if (health && !health.ok) {
        logger.warn("OpenCode backend unavailable; bot will start but replies may fail", {
            baseUrl: loaded.config.opencode.baseUrl,
            detail: health.detail,
        });
    }
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
async function runInit() {
    const configIndex = process.argv.indexOf("--config");
    const explicit = configIndex >= 0 ? process.argv[configIndex + 1] : undefined;
    const configPath = explicit ?? process.env.ATME_CONFIG ?? defaultConfigPath();
    process.env.ATME_CONFIG = configPath;
    const envPath = join(dirname(configPath), ".env");
    const force = process.argv.includes("--force");
    if (!existsSync(configPath) || force) {
        process.stdout.write(`初始化配置：${configPath}\n`);
        await runSetup({
            ...(explicit ? { configPath } : {}),
            nonInteractive: process.argv.includes("--yes"),
        });
    }
    else {
        process.stdout.write(`配置已存在：${configPath}（--force 可重跑 setup）\n`);
    }
    loadDotenv({ path: envPath, override: true, quiet: true });
    loadDotenv({ override: true, quiet: true });
    await installAgents();
    try {
        await listChats(true);
    }
    catch (error) {
        process.stdout.write(`群同步跳过：${toErrorMessage(error)}\n`);
    }
    const checks = await runDoctor(configPath);
    let failed = 0;
    for (const check of checks) {
        process.stdout.write(`${check.ok ? "✅" : "❌"} ${check.label}${check.detail ? ` — ${check.detail}` : ""}\n`);
        if (!check.ok) {
            failed++;
            if (check.fix)
                process.stdout.write(`   fix: ${check.fix}\n`);
        }
    }
    process.stdout.write(failed === 0
        ? "\n初始化完成，可以启动：atme-proxy start\n"
        : `\n还有 ${failed} 项未通过，按上面的 fix 处理后重跑：atme-proxy init\n`);
    printServiceHint();
    if (failed > 0)
        process.exitCode = 1;
}
function printServiceHint() {
    if (process.platform !== "linux")
        return;
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const script = join(root, "deploy", "systemd", "install.sh");
    if (!existsSync("/run/systemd/system")) {
        process.stdout.write("开机自启：未检测到 systemd，见 README 3.1。\n");
        return;
    }
    if (!existsSync(script)) {
        process.stdout.write("开机自启：见 README 3.1（systemd）。\n");
        return;
    }
    process.stdout.write(`开机自启（可选）：sudo bash ${script}\n`);
    if (script.includes("/_npx/") || script.includes("/npm-cache/")) {
        process.stdout.write("注意：当前是 npm exec 临时缓存路径，长期服务请先全局安装或 clone 仓库。\n");
    }
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
async function listChats(sync = false) {
    const loaded = await loadConfig();
    const secret = loaded.secrets.appSecret;
    if (!secret)
        throw new Error("Feishu app secret is required");
    const feishu = loaded.config.platforms.feishu;
    const client = new Lark.Client({
        appId: feishu.appId,
        appSecret: secret,
        domain: feishu.domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu,
        logger: { error: () => { }, warn: () => { }, info: () => { }, debug: () => { }, trace: () => { } },
    });
    let pageToken;
    let count = 0;
    const discovered = [];
    do {
        const response = await client.request({
            method: "GET",
            url: "/open-apis/im/v1/chats",
            params: {
                page_size: 100,
                ...(pageToken ? { page_token: pageToken } : {}),
            },
        });
        if (response?.code !== 0) {
            throw new Error(`飞书群列表失败: ${response?.msg ?? "unknown"}`);
        }
        const items = Array.isArray(response?.data?.items) ? response.data.items : [];
        for (const item of items) {
            count++;
            discovered.push({
                chatId: item.chat_id,
                ...(item.name ? { name: item.name } : {}),
            });
            process.stdout.write(`${item.chat_id}\t${item.name ?? ""}\n`);
        }
        pageToken = response?.data?.has_more ? response.data.page_token : undefined;
    } while (pageToken);
    if (count === 0) {
        process.stdout.write("没有查到群。先把机器人拉进群，再运行一次。\n");
        return;
    }
    if (!sync)
        return;
    const { loadConfig: reload, defaultConfigPath } = await import("./core/config.js");
    const path = process.env.ATME_CONFIG ?? defaultConfigPath();
    const { readFile, writeFile, chmod } = await import("node:fs/promises");
    const raw = JSON.parse(await readFile(path, "utf8"));
    const feishuRaw = (raw.platforms ??= {}).feishu ??= {};
    const existingGroups = Array.isArray(feishuRaw.groups) ? feishuRaw.groups : [];
    const byId = new Map(discovered.map((item) => [item.chatId, item]));
    const merged = existingGroups.map((group) => ({
        ...group,
        ...(byId.get(group.chatId)?.name ? { name: byId.get(group.chatId).name } : {}),
    }));
    for (const item of discovered) {
        if (!merged.some((group) => group.chatId === item.chatId)) {
            merged.push({ chatId: item.chatId, name: item.name ?? item.chatId, enabled: true });
        }
    }
    feishuRaw.groups = merged;
    await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(path, 0o600);
    void reload;
    process.stdout.write(`已同步 ${merged.length} 个群到 ${path}\n`);
    process.stdout.write("重启 atme-proxy 后生效。\n");
}
async function main() {
    bootstrapEnv();
    const logger = createLogger({ scope: "cli" });
    const command = process.argv[2] ?? "help";
    if (command === "init") {
        await runInit();
        return;
    }
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
    if (command === "chats") {
        await listChats(process.argv.includes("--sync"));
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
            "  atme-proxy init             setup + agents + chats --sync + doctor",
            "  atme-proxy chats [--sync]   list groups; --sync writes chat ids and names to config",
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