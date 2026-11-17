import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "./logger.js";
import { truncateMiddle, toErrorMessage } from "./util.js";
const UNSAFE = /[/\\:*?"<>|]/g;
function sanitize(value) {
    return value.replace(UNSAFE, "_").slice(0, 80);
}
function dateStamp(ts) {
    const date = new Date(ts);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}
export class EvidenceStore {
    options;
    enabled;
    logger;
    now;
    dirs = new Map();
    constructor(options) {
        this.options = options;
        this.enabled = options.enabled !== false;
        this.logger = options.logger ?? createLogger({ scope: "evidence" });
        this.now = options.now ?? Date.now;
    }
    append(record) {
        if (!this.enabled)
            return;
        try {
            const dir = this.chatDir(record.chatId, record.chatName);
            mkdirSync(dir, { recursive: true, mode: 0o700 });
            const entry = {
                ...record,
                text: truncateMiddle(record.text, this.options.maxChars),
            };
            appendFileSync(join(dir, `${dateStamp(record.ts)}.jsonl`), `${JSON.stringify(entry)}\n`, {
                mode: 0o600,
            });
        }
        catch (error) {
            this.logger.warn("evidence append failed", {
                chatId: record.chatId,
                messageId: record.messageId,
                error: toErrorMessage(error),
            });
        }
    }
    prune() {
        if (!this.enabled)
            return;
        const cutoff = this.now() - this.options.retentionDays * 86_400_000;
        let chats;
        try {
            chats = readdirSync(this.options.dir);
        }
        catch {
            return;
        }
        for (const chat of chats) {
            const dir = join(this.options.dir, chat);
            let files;
            try {
                if (!statSync(dir).isDirectory())
                    continue;
                files = readdirSync(dir);
            }
            catch {
                continue;
            }
            for (const file of files) {
                if (!file.endsWith(".jsonl"))
                    continue;
                const stamp = file.slice(0, 10);
                const ts = Date.parse(`${stamp}T00:00:00`);
                if (Number.isNaN(ts) || ts >= cutoff)
                    continue;
                try {
                    rmSync(join(dir, file));
                }
                catch (error) {
                    this.logger.warn("evidence prune failed", {
                        file,
                        error: toErrorMessage(error),
                    });
                }
            }
        }
    }
    chatDir(chatId, chatName) {
        const cached = this.dirs.get(chatId);
        if (cached)
            return cached;
        const name = chatName ? sanitize(chatName) : "群";
        const dir = join(this.options.dir, `${name}__${sanitize(chatId)}`);
        this.dirs.set(chatId, dir);
        return dir;
    }
}
//# sourceMappingURL=evidence-store.js.map