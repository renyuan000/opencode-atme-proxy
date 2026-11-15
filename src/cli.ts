import "dotenv/config";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { loadConfig, resolveLogFile, resolveStateDir, type LoadedConfig } from "./core/config.js";
import { createLogger, type Logger } from "./core/logger.js";
import { FeishuAdapter } from "./adapters/feishu/adapter.js";
import { FeishuEventSource } from "./adapters/feishu/events.js";
import { HybridFeishuAdapter } from "./adapters/feishu/hybrid.js";
import { HttpOpenCodeBridge } from "./core/opencode.js";
import { ProxyRuntime } from "./core/runtime.js";
import { toErrorMessage } from "./core/util.js";
import { acquireInstanceLock, releaseInstanceLock } from "./core/instance-lock.js";

export interface StartOptions {
  configPath?: string;
}

export async function startDaemon(options: StartOptions = {}): Promise<{
  stop(): Promise<void>;
}> {
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
  if (!appSecret) throw new Error("Feishu app secret is required");

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
    platform: hybrid as unknown as import("./core/ports.js").PlatformAdapter,
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

async function main(): Promise<void> {
  const logger = createLogger({ scope: "cli" });
  const command = process.argv[2] ?? "start";
  if (command !== "start") {
    process.stderr.write(`usage: atme-proxy start\n`);
    process.exitCode = 1;
    return;
  }
  let handle: { stop(): Promise<void> } | undefined;
  try {
    handle = await startDaemon();
  } catch (error) {
    logger.error("failed to start", { error: toErrorMessage(error) });
    throw error;
  }
  const shutdown = async (signal: string): Promise<void> => {
    logger.info("shutting down", { signal, pid: process.pid });
    try {
      await handle?.stop();
    } catch (error) {
      logger.error("shutdown failed", { error: toErrorMessage(error) });
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  logger.info("daemon running", { pid: process.pid, runId: randomUUID() });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error) => {
    process.stderr.write(`${toErrorMessage(error)}\n`);
    process.exit(1);
  });
}

export type { LoadedConfig, Logger };
