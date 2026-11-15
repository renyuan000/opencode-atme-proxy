import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { expandHome, toErrorMessage } from "./util.js";
const levels = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};
const secretKeyPattern = /secret|token|authorization|api[-_]?key|password|passwd|credential|private[-_]?key/i;
const nonSecretMetricKeys = new Set([
    "tokens",
    "totalTokens",
    "promptTokens",
    "completionTokens",
    "maxTokensPerRun",
    "maxMessagesPerRun",
]);
function redact(value, depth = 0) {
    if (depth > 6)
        return "[depth-limit]";
    if (value instanceof Error) {
        return { name: value.name, message: toErrorMessage(value) };
    }
    if (Array.isArray(value)) {
        return value.slice(0, 50).map((item) => redact(item, depth + 1));
    }
    if (value && typeof value === "object") {
        const result = {};
        for (const [key, inner] of Object.entries(value)) {
            result[key] =
                !nonSecretMetricKeys.has(key) && secretKeyPattern.test(key)
                    ? "[REDACTED]"
                    : redact(inner, depth + 1);
        }
        return result;
    }
    if (typeof value === "string" && value.length > 2000) {
        return `${value.slice(0, 2000)}…`;
    }
    return value;
}
export function createLogger(options) {
    const threshold = levels[options.level ?? "info"];
    const file = options.file ? expandHome(options.file) : undefined;
    if (file) {
        try {
            mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        }
        catch {
            // Logging must never crash the process.
        }
    }
    const write = (level, message, fields) => {
        if (levels[level] < threshold)
            return;
        const entry = {
            ts: new Date().toISOString(),
            level,
            scope: options.scope,
            msg: message,
            ...(fields ? redact(fields) : {}),
        };
        const line = `${JSON.stringify(entry)}\n`;
        process.stderr.write(line);
        if (file) {
            try {
                appendFileSync(file, line, { encoding: "utf8", mode: 0o600 });
            }
            catch {
                // Ignore file logging failures.
            }
        }
    };
    return {
        debug: (message, fields) => write("debug", message, fields),
        info: (message, fields) => write("info", message, fields),
        warn: (message, fields) => write("warn", message, fields),
        error: (message, fields) => write("error", message, fields),
        child: (scope) => createLogger({
            scope: `${options.scope}:${scope}`,
            level: options.level,
            file: options.file,
        }),
    };
}
export function createSilentLogger() {
    const noop = () => { };
    return {
        debug: noop,
        info: noop,
        warn: noop,
        error: noop,
        child: () => createSilentLogger(),
    };
}
//# sourceMappingURL=logger.js.map