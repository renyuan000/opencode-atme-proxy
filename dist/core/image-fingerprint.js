import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
const cache = new Map();
const inFlight = new Map();
const CACHE_LIMIT = 100;
function python(options) {
    return (options.python ??
        process.env.ATME_RAPIDOCR_PYTHON ??
        (existsSync(join(homedir(), ".local/share/atme-ocr-venv/bin/python"))
            ? join(homedir(), ".local/share/atme-ocr-venv/bin/python")
            : "python3"));
}
function script(options) {
    return options.script ?? join(process.cwd(), "scripts/image-fingerprint.py");
}
function sampleKey(data, mime) {
    return `${createHash("sha256").update(data).digest("hex")}:${mime}`;
}
export function hammingDistance(left, right) {
    if (left.length !== right.length)
        return Number.POSITIVE_INFINITY;
    let distance = 0;
    for (let index = 0; index < left.length; index += 1) {
        const a = Number.parseInt(left[index], 16);
        const b = Number.parseInt(right[index], 16);
        let value = a ^ b;
        while (value) {
            distance += value & 1;
            value >>= 1;
        }
    }
    return distance;
}
export async function imageFingerprint(data, mime, options = {}) {
    const key = sampleKey(data, mime);
    const cached = cache.get(key);
    if (cached)
        return cached;
    const pending = inFlight.get(key);
    if (pending)
        return pending;
    const task = (async () => {
        const scriptPath = script(options);
        if (!existsSync(scriptPath))
            return undefined;
        const dir = await mkdtemp(join(tmpdir(), "atme-image-fp-"));
        const ext = mime.includes("jpeg") || mime.includes("jpg") ? ".jpg" : ".png";
        const file = join(dir, `image${ext}`);
        try {
            await writeFile(file, data);
            const { stdout } = await execFileAsync(python(options), [scriptPath, file], {
                timeout: options.timeoutMs ?? 10_000,
                maxBuffer: 256 * 1024,
            });
            const value = JSON.parse(String(stdout ?? "").trim());
            if (typeof value.width !== "number" ||
                typeof value.height !== "number" ||
                typeof value.dhash !== "string") {
                return undefined;
            }
            const result = {
                width: value.width,
                height: value.height,
                dhash: value.dhash,
            };
            cache.set(key, result);
            while (cache.size > CACHE_LIMIT) {
                const oldest = cache.keys().next().value;
                if (oldest === undefined)
                    break;
                cache.delete(oldest);
            }
            return result;
        }
        catch {
            return undefined;
        }
        finally {
            await rm(dir, { recursive: true, force: true }).catch(() => { });
        }
    })();
    inFlight.set(key, task);
    try {
        return await task;
    }
    finally {
        inFlight.delete(key);
    }
}
//# sourceMappingURL=image-fingerprint.js.map