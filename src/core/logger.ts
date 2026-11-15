import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { expandHome, toErrorMessage } from "./util.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const levels: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export interface LoggerOptions {
  scope: string;
  level?: LogLevel;
  file?: string;
}

const secretKeyPattern =
  /secret|token|authorization|api[-_]?key|password|passwd|credential|private[-_]?key/i;
const nonSecretMetricKeys = new Set([
  "tokens",
  "totalTokens",
  "promptTokens",
  "completionTokens",
  "maxTokensPerRun",
  "maxMessagesPerRun",
]);

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth-limit]";
  if (value instanceof Error) {
    return { name: value.name, message: toErrorMessage(value) };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redact(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
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

export function createLogger(options: LoggerOptions): Logger {
  const threshold = levels[options.level ?? "info"];
  const file = options.file ? expandHome(options.file) : undefined;
  if (file) {
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    } catch {
      // Logging must never crash the process.
    }
  }

  const write = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (levels[level] < threshold) return;
    const entry = {
      ts: new Date().toISOString(),
      level,
      scope: options.scope,
      msg: message,
      ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
    };
    const line = `${JSON.stringify(entry)}\n`;
    process.stderr.write(line);
    if (file) {
      try {
        appendFileSync(file, line, { encoding: "utf8", mode: 0o600 });
      } catch {
        // Ignore file logging failures.
      }
    }
  };

  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
    child: (scope) =>
      createLogger({
        scope: `${options.scope}:${scope}`,
        level: options.level,
        file: options.file,
      }),
  };
}

export function createSilentLogger(): Logger {
  const noop = (): void => {};
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => createSilentLogger(),
  };
}
