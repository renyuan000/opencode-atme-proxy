import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { hammingDistance, imageFingerprint } from "./image-fingerprint.js";
const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CHARS = 8_000;
const DEFAULT_LANGUAGE = "chi_sim+eng";
const CACHE_LIMIT = 50;
const cache = new Map();
const inFlight = new Map();
const visualCache = [];
const NEAR_DUPLICATE_DISTANCE = 4;
function imageExtension(mime) {
    if (mime.includes("jpeg") || mime.includes("jpg"))
        return ".jpg";
    if (mime.includes("webp"))
        return ".webp";
    if (mime.includes("gif"))
        return ".gif";
    return ".png";
}
function rapidPython(options) {
    return (options.rapidocrPython ??
        process.env.ATME_RAPIDOCR_PYTHON ??
        (existsSync(join(homedir(), ".local/share/atme-ocr-venv/bin/python"))
            ? join(homedir(), ".local/share/atme-ocr-venv/bin/python")
            : "python3"));
}
function rapidScript(options) {
    return options.rapidocrScript ?? join(process.cwd(), "scripts/ocr-rapid.py");
}
async function withImageFile(data, mime, run) {
    const dir = await mkdtemp(join(tmpdir(), "atme-ocr-"));
    const file = join(dir, `image${imageExtension(mime)}`);
    try {
        await writeFile(file, data);
        return await run(file);
    }
    catch {
        return undefined;
    }
    finally {
        await rm(dir, { recursive: true, force: true }).catch(() => { });
    }
}
async function tesseract(data, mime, options) {
    const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
    const language = options.language ?? DEFAULT_LANGUAGE;
    const text = await withImageFile(data, mime, async (file) => {
        const { stdout } = await execFileAsync("tesseract", [
            file,
            "stdout",
            "-l",
            language,
            "--oem",
            "1",
            "--psm",
            "6",
            "-c",
            "preserve_interword_spaces=1",
        ], { timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 });
        return String(stdout ?? "").trim();
    });
    if (!text)
        return undefined;
    return { text: text.slice(0, maxChars), provider: "tesseract" };
}
async function rapidocr(data, mime, options) {
    const script = rapidScript(options);
    if (!existsSync(script))
        return undefined;
    const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
    const parsed = await withImageFile(data, mime, async (file) => {
        const { stdout } = await execFileAsync(rapidPython(options), [script, file], {
            timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            maxBuffer: 4 * 1024 * 1024,
        });
        const value = JSON.parse(String(stdout ?? "").trim());
        const text = typeof value.text === "string" ? value.text.trim() : "";
        if (!text)
            return undefined;
        return {
            text: text.slice(0, maxChars),
            provider: "rapidocr",
            ...(typeof value.confidence === "number" ? { confidence: value.confidence } : {}),
        };
    });
    return parsed;
}
function fingerprint(data, mime, options, provider) {
    const contentHash = createHash("sha256").update(data).digest("hex");
    return [
        contentHash,
        mime,
        provider,
        String(options.maxChars ?? DEFAULT_MAX_CHARS),
        options.language ?? DEFAULT_LANGUAGE,
        options.scope ?? "global",
    ].join(":");
}
export async function recognizeImage(data, mime, options = {}) {
    const provider = options.provider ?? "auto";
    const key = fingerprint(data, mime, options, provider);
    const cached = cache.get(key);
    if (cached) {
        cache.delete(key);
        cache.set(key, cached);
        return cached;
    }
    const pending = inFlight.get(key);
    if (pending)
        return pending;
    const scope = options.scope ?? "global";
    const visual = options.allowNearDuplicate
        ? await imageFingerprint(data, mime)
        : undefined;
    if (visual) {
        const match = visualCache.find((entry) => entry.scope === scope &&
            hammingDistance(entry.dhash, visual.dhash) <= NEAR_DUPLICATE_DISTANCE);
        if (match)
            return { ...match.result, nearDuplicateOf: visual.dhash };
    }
    const task = (async () => {
        let result;
        if (provider === "rapidocr" || provider === "auto") {
            result = await rapidocr(data, mime, options);
        }
        if (!result && provider !== "rapidocr") {
            result = await tesseract(data, mime, options);
        }
        if (result) {
            const enriched = visual
                ? {
                    ...result,
                    width: visual.width,
                    height: visual.height,
                    dhash: visual.dhash,
                }
                : result;
            cache.set(key, enriched);
            if (visual) {
                visualCache.push({ scope, dhash: visual.dhash, result: enriched });
                while (visualCache.length > CACHE_LIMIT)
                    visualCache.shift();
            }
            while (cache.size > CACHE_LIMIT) {
                const oldest = cache.keys().next().value;
                if (oldest === undefined)
                    break;
                cache.delete(oldest);
            }
            return enriched;
        }
        return result;
    })();
    inFlight.set(key, task);
    try {
        return await task;
    }
    finally {
        inFlight.delete(key);
    }
}
export async function ocrImage(data, mime, options = {}) {
    return (await recognizeImage(data, mime, options))?.text;
}
//# sourceMappingURL=ocr.js.map