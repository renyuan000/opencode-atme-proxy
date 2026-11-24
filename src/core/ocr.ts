import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type OcrProvider = "auto" | "tesseract" | "rapidocr";

export interface OcrOptions {
  provider?: OcrProvider;
  timeoutMs?: number;
  maxChars?: number;
  language?: string;
  rapidocrPython?: string;
  rapidocrScript?: string;
}

export interface OcrResult {
  text: string;
  provider: "tesseract" | "rapidocr";
  confidence?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CHARS = 8_000;
const DEFAULT_LANGUAGE = "chi_sim+eng";
const CACHE_LIMIT = 50;
const cache = new Map<string, OcrResult>();

function imageExtension(mime: string): string {
  if (mime.includes("jpeg") || mime.includes("jpg")) return ".jpg";
  if (mime.includes("webp")) return ".webp";
  if (mime.includes("gif")) return ".gif";
  return ".png";
}

function rapidPython(options: OcrOptions): string {
  return (
    options.rapidocrPython ??
    process.env.ATME_RAPIDOCR_PYTHON ??
    (existsSync(join(homedir(), ".local/share/atme-ocr-venv/bin/python"))
      ? join(homedir(), ".local/share/atme-ocr-venv/bin/python")
      : "python3")
  );
}

function rapidScript(options: OcrOptions): string {
  return options.rapidocrScript ?? join(process.cwd(), "scripts/ocr-rapid.py");
}

async function withImageFile<T>(
  data: Buffer,
  mime: string,
  run: (file: string) => Promise<T>,
): Promise<T | undefined> {
  const dir = await mkdtemp(join(tmpdir(), "atme-ocr-"));
  const file = join(dir, `image${imageExtension(mime)}`);
  try {
    await writeFile(file, data);
    return await run(file);
  } catch {
    return undefined;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function tesseract(data: Buffer, mime: string, options: OcrOptions): Promise<OcrResult | undefined> {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const language = options.language ?? DEFAULT_LANGUAGE;
  const text = await withImageFile(data, mime, async (file) => {
    const { stdout } = await execFileAsync(
      "tesseract",
      [
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
      ],
      { timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 },
    );
    return String(stdout ?? "").trim();
  });
  if (!text) return undefined;
  return { text: text.slice(0, maxChars), provider: "tesseract" };
}

async function rapidocr(data: Buffer, mime: string, options: OcrOptions): Promise<OcrResult | undefined> {
  const script = rapidScript(options);
  if (!existsSync(script)) return undefined;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const parsed = await withImageFile(data, mime, async (file) => {
    const { stdout } = await execFileAsync(rapidPython(options), [script, file], {
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    const value = JSON.parse(String(stdout ?? "").trim()) as {
      text?: unknown;
      confidence?: unknown;
    };
    const text = typeof value.text === "string" ? value.text.trim() : "";
    if (!text) return undefined;
    return {
      text: text.slice(0, maxChars),
      provider: "rapidocr" as const,
      ...(typeof value.confidence === "number" ? { confidence: value.confidence } : {}),
    };
  });
  return parsed;
}

export async function recognizeImage(
  data: Buffer,
  mime: string,
  options: OcrOptions = {},
): Promise<OcrResult | undefined> {
  const provider = options.provider ?? "auto";
  const key = createHash("sha256")
    .update(data)
    .update("\0")
    .update(mime)
    .update("\0")
    .update(provider)
    .update("\0")
    .update(String(options.maxChars ?? DEFAULT_MAX_CHARS))
    .update("\0")
    .update(options.language ?? DEFAULT_LANGUAGE)
    .digest("hex");
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  let result: OcrResult | undefined;
  if (provider === "rapidocr" || provider === "auto") {
    result = await rapidocr(data, mime, options);
  }
  if (!result && provider !== "rapidocr") {
    result = await tesseract(data, mime, options);
  }
  if (result) {
    cache.set(key, result);
    while (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }
  return result;
}

export async function ocrImage(
  data: Buffer,
  mime: string,
  options: OcrOptions = {},
): Promise<string | undefined> {
  return (await recognizeImage(data, mime, options))?.text;
}
