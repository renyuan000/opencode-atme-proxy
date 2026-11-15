import "dotenv/config";
import { loadConfig, resolveStateDir } from "../core/config.js";
import { createLogger } from "../core/logger.js";
import { FeishuAdapter } from "../adapters/feishu/adapter.js";
import { toErrorMessage } from "../core/util.js";
async function main() {
    const loaded = await loadConfig();
    const logger = createLogger({
        scope: "probe",
        level: loaded.config.app.logLevel,
    });
    const appSecret = loaded.secrets.appSecret;
    if (!appSecret)
        throw new Error("Feishu app secret is required");
    const adapter = new FeishuAdapter({
        config: loaded.config.platforms.feishu,
        appSecret,
        logger,
    });
    const groups = loaded.config.platforms.feishu.groups.filter((group) => group.enabled);
    if (groups.length === 0)
        throw new Error("no enabled groups in config");
    const minutes = Number(process.env.ATME_PROBE_MINUTES ?? "5");
    const endTime = Date.now();
    const startTime = endTime - minutes * 60_000;
    for (const group of groups) {
        logger.info("probing group", { chatId: group.chatId, name: group.name, minutes });
        try {
            const result = await adapter.listMessages({
                chatId: group.chatId,
                startTime,
                endTime,
                maxPages: 5,
                maxMessages: 200,
            });
            logger.info("probe result", {
                chatId: group.chatId,
                count: result.messages.length,
                nextCursor: result.nextCursor,
            });
            for (const message of result.messages) {
                process.stdout.write(`${new Date(message.createdAt).toISOString()} ${message.sender.id} ${message.rawType} ${message.text.slice(0, 200)}\n`);
            }
        }
        catch (error) {
            logger.error("probe failed", {
                chatId: group.chatId,
                error: toErrorMessage(error),
            });
            process.exitCode = 1;
        }
    }
    void resolveStateDir(loaded.config);
}
void main().catch((error) => {
    process.stderr.write(`${toErrorMessage(error)}\n`);
    process.exit(1);
});
//# sourceMappingURL=probe-history.js.map