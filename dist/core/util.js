import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
export async function ensureDir(dir) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
}
export async function readJsonFile(path, fallback) {
    try {
        const raw = await readFile(path, "utf8");
        return JSON.parse(raw);
    }
    catch (error) {
        if (isMissingFile(error))
            return fallback;
        throw error;
    }
}
export async function writeJsonAtomic(path, value) {
    await ensureDir(dirname(path));
    const tmp = `${path}.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, path);
}
export function isMissingFile(error) {
    return (typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT");
}
export function localTimestamp(date = new Date()) {
    const pad = (value) => String(value).padStart(2, "0");
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
export function formatLocalTime(timestamp) {
    const date = new Date(timestamp);
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export function sha256(input) {
    return createHash("sha256").update(input).digest("hex");
}
export function stableUuid(...parts) {
    const hex = sha256(parts.join("|"));
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
export function expandHome(path) {
    if (path === "~")
        return process.env.HOME ?? path;
    if (path.startsWith("~/"))
        return `${process.env.HOME ?? ""}/${path.slice(2)}`;
    return path;
}
export function truncate(text, maxChars) {
    if (text.length <= maxChars)
        return text;
    return `${text.slice(0, maxChars)}…`;
}
export function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
export function toErrorMessage(error) {
    if (error instanceof Error)
        return error.message;
    if (typeof error === "string")
        return error;
    try {
        return JSON.stringify(error);
    }
    catch {
        return String(error);
    }
}
export function uniqueBy(items, key) {
    const seen = new Set();
    const result = [];
    for (const item of items) {
        const id = key(item);
        if (seen.has(id))
            continue;
        seen.add(id);
        result.push(item);
    }
    return result;
}
//# sourceMappingURL=util.js.map