import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

export async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if (isMissingFile(error)) return fallback;
    throw error;
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

export function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

export function localTimestamp(date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    "T",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
    ":",
    pad(date.getSeconds()),
    ".",
    String(date.getMilliseconds()).padStart(3, "0"),
    sign,
    pad(Math.floor(abs / 60)),
    ":",
    pad(abs % 60),
  ].join("");
}

export function formatLocalTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function stableUuid(...parts: string[]): string {
  const hex = sha256(parts.join("|"));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function expandHome(path: string): string {
  if (path === "~") return process.env.HOME ?? path;
  if (path.startsWith("~/")) return `${process.env.HOME ?? ""}/${path.slice(2)}`;
  return path;
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

export function truncateMiddle(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  const marker = "…[截断]…";
  const markerLength = Array.from(marker).length;
  if (maxChars <= markerLength) return Array.from(marker).slice(0, maxChars).join("");
  const remaining = maxChars - markerLength;
  const head = Math.ceil(remaining * 0.7);
  const tail = remaining - head;
  const tailText = tail > 0 ? chars.slice(chars.length - tail).join("") : "";
  return `${chars.slice(0, head).join("")}${marker}${tailText}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function isLowValueMessage(text: string): boolean {
  const compact = text.replace(/[\s\p{P}\p{S}]/gu, "");
  if (!compact) return true;
  return /^(收到|好的|好|ok|可以|嗯|谢谢|感谢|辛苦了)$/i.test(compact);
}

export function redactPreview(text: string, maxChars = 80): string {
  let out = text;
  out = out.replace(
    /((?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*)\S+/gi,
    "$1[REDACTED]",
  );
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]");
  out = out.replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, "[REDACTED]");
  return truncate(out, maxChars);
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const id = key(item);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(item);
  }
  return result;
}
