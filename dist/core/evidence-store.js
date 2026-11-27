import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "./logger.js";
import { truncateMiddle, toErrorMessage } from "./util.js";
const UNSAFE = /[/\\:*?"<>|]/g;
function sanitize(value) {
    return value.replace(UNSAFE, "_").slice(0, 80);
}
function monthStamp(ts) {
    const date = new Date(ts);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    return `${year}-${month}`;
}
function filePeriodStart(file) {
    const value = file.replace(/\.jsonl$/, "");
    if (/^\d{4}-\d{2}$/.test(value))
        return Date.parse(`${value}-01T00:00:00`);
    if (/^\d{4}-\d{2}-\d{2}$/.test(value))
        return Date.parse(`${value}T00:00:00`);
    return Number.NaN;
}
function filePeriodEnd(file) {
    const value = file.replace(/\.jsonl$/, "");
    if (/^\d{4}-\d{2}$/.test(value)) {
        const [year, month] = value.split("-").map(Number);
        return new Date(year, month, 1).getTime();
    }
    const start = filePeriodStart(file);
    return Number.isNaN(start) ? Number.NaN : start + 86_400_000;
}
export class EvidenceStore {
    options;
    enabled;
    logger;
    now;
    dirs = new Map();
    activeMonths = new Map();
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
            const month = monthStamp(record.ts);
            const entry = {
                ...record,
                text: truncateMiddle(record.text, this.options.maxChars),
            };
            appendFileSync(join(dir, `${month}.jsonl`), `${JSON.stringify(entry)}\n`, {
                mode: 0o600,
            });
            if (this.activeMonths.get(record.chatId) !== month) {
                this.activeMonths.set(record.chatId, month);
                writeFileSync(join(dir, "pointer.json"), `${JSON.stringify({ version: 1, active: month, updatedAt: this.now() })}\n`, { encoding: "utf8", mode: 0o600 });
            }
        }
        catch (error) {
            this.logger.warn("evidence append failed", {
                chatId: record.chatId,
                messageId: record.messageId,
                error: toErrorMessage(error),
            });
        }
    }
    search(input) {
        if (!this.enabled || input.terms.length === 0)
            return [];
        const terms = input.terms.map((term) => term.toLowerCase()).filter(Boolean);
        const cutoff = this.now() - (input.days ?? 7) * 86_400_000;
        const limit = input.limit ?? 5;
        const results = [];
        for (const dir of this.findChatDirs(input.chatId)) {
            let files;
            try {
                files = readdirSync(dir).filter((file) => file.endsWith(".jsonl")).sort().reverse();
            }
            catch {
                continue;
            }
            for (const file of files) {
                const periodEnd = filePeriodEnd(file);
                if (Number.isNaN(periodEnd) || periodEnd < cutoff)
                    continue;
                let raw;
                try {
                    raw = readFileSync(join(dir, file), "utf8");
                }
                catch {
                    continue;
                }
                for (const line of raw.split("\n")) {
                    if (!line.trim())
                        continue;
                    let record;
                    try {
                        record = JSON.parse(line);
                    }
                    catch {
                        continue;
                    }
                    if (record.ts < cutoff)
                        continue;
                    const haystack = record.text.toLowerCase();
                    if (!terms.some((term) => haystack.includes(term)))
                        continue;
                    results.push(record);
                    if (results.length >= limit)
                        return results;
                }
            }
        }
        return results;
    }
    findByMessageId(input) {
        if (!this.enabled)
            return undefined;
        const cutoff = this.now() - (input.days ?? 30) * 86_400_000;
        for (const dir of this.findChatDirs(input.chatId)) {
            let files;
            try {
                files = readdirSync(dir).filter((file) => file.endsWith(".jsonl")).sort().reverse();
            }
            catch {
                continue;
            }
            for (const file of files) {
                const periodEnd = filePeriodEnd(file);
                if (Number.isNaN(periodEnd) || periodEnd < cutoff)
                    continue;
                let raw;
                try {
                    raw = readFileSync(join(dir, file), "utf8");
                }
                catch {
                    continue;
                }
                for (const line of raw.split("\n")) {
                    if (!line.trim())
                        continue;
                    try {
                        const record = JSON.parse(line);
                        if (record.ts < cutoff)
                            continue;
                        if (record.messageId === input.messageId)
                            return record;
                    }
                    catch {
                        continue;
                    }
                }
            }
        }
        return undefined;
    }
    redact(chatId, messageId) {
        if (!this.enabled)
            return;
        for (const dir of this.findChatDirs(chatId)) {
            let files;
            try {
                files = readdirSync(dir).filter((file) => file.endsWith(".jsonl"));
            }
            catch {
                continue;
            }
            for (const file of files) {
                const path = join(dir, file);
                try {
                    const lines = readFileSync(path, "utf8").split("\n");
                    let changed = false;
                    const next = lines.map((line) => {
                        if (!line.trim())
                            return line;
                        try {
                            const record = JSON.parse(line);
                            if (record.messageId !== messageId)
                                return line;
                            changed = true;
                            return JSON.stringify({ ...record, text: "[已撤回]", attachments: undefined });
                        }
                        catch {
                            return line;
                        }
                    });
                    if (changed)
                        writeFileSync(path, next.join("\n"), "utf8");
                }
                catch (error) {
                    this.logger.warn("evidence redact failed", { chatId, messageId, error: toErrorMessage(error) });
                }
            }
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
                const periodEnd = filePeriodEnd(file);
                if (Number.isNaN(periodEnd) || periodEnd >= cutoff)
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
    findChatDirs(chatId) {
        const suffix = `__${sanitize(chatId)}`;
        try {
            return readdirSync(this.options.dir)
                .filter((name) => name.endsWith(suffix))
                .map((name) => join(this.options.dir, name));
        }
        catch {
            return [];
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