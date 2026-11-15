import type { Plugin, PluginModule } from "@opencode-ai/plugin";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { loadConfig, resolveLogFile } from "./core/config.js";
import { createLogger } from "./core/logger.js";
import { FeishuAdapter } from "./adapters/feishu/adapter.js";
import { FeishuEventSource } from "./adapters/feishu/events.js";
import { HybridFeishuAdapter } from "./adapters/feishu/hybrid.js";
import { InjectedOpenCodeBridge } from "./core/opencode.js";
import { ProxyRuntime } from "./core/runtime.js";
import { toErrorMessage } from "./core/util.js";
import { acquireInstanceLock, releaseInstanceLock } from "./core/instance-lock.js";
import { join } from "node:path";
import { resolveStateDir } from "./core/config.js";

const plugin = {
  id: "atme-proxy",
  async server(input: {
    client?: unknown;
    directory?: string;
    serverUrl?: URL;
  }): Promise<{ dispose?: () => Promise<void> }> {
    const logger = createLogger({ scope: "plugin" });
    let runtime: ProxyRuntime | undefined;
    let lockPath: string | undefined;
    try {
      const loaded = await loadConfig();
      const logFile = resolveLogFile(loaded.config);
      if (logFile) logger.info("plugin log file configured", { file: logFile });
      const appSecret = loaded.secrets.appSecret;
      if (!appSecret) throw new Error("Feishu app secret is required");
      const stateDir = resolveStateDir(loaded.config);
      lockPath = join(stateDir, "instance.lock");
      await acquireInstanceLock(lockPath, logger);
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
      const client =
        (input.client as ReturnType<typeof createOpencodeClient> | undefined) ??
        createOpencodeClient({ baseUrl: loaded.config.opencode.baseUrl });
      const bridge = new InjectedOpenCodeBridge(
        client as unknown as ConstructorParameters<typeof InjectedOpenCodeBridge>[0],
        logger.child("opencode"),
      );
      runtime = new ProxyRuntime({
        platform: hybrid as unknown as import("./core/ports.js").PlatformAdapter,
        bridge,
        loaded,
        logger: logger.child("runtime"),
      });
      await runtime.start();
      logger.info("plugin started");
      return {
        dispose: async () => {
          await runtime?.stop();
          if (lockPath) await releaseInstanceLock(lockPath, logger);
        },
      };
    } catch (error) {
      logger.error("plugin failed to start", { error: toErrorMessage(error) });
      if (lockPath) await releaseInstanceLock(lockPath, logger);
      return {
        dispose: async () => {},
      };
    }
  },
};

const pluginModule: PluginModule = {
  id: plugin.id,
  server: plugin.server as unknown as Plugin,
};

export default pluginModule;
