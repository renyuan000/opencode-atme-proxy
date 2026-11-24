import { execFile } from "node:child_process";
import * as XLSX from "xlsx";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtractedDocument, ReadRange } from "./file-envelope.js";

const execFileAsync = promisify(execFile);
const MAX_EXTRACT_CHARS = 20_000;

function extension(name: string | undefined, mime: string): string {
  const fromName = name?.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  if (fromName) return fromName;
  if (mime.includes("pdf")) return "pdf";
  if (mime.includes("wordprocessingml")) return "docx";
  if (mime.includes("text/")) return "txt";
  return "bin";
}

async function run(command: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return String(stdout ?? "").trim() || undefined;
  } catch {
    return undefined;
  }
}

function finish(text: string | undefined, extractor: string): ExtractedDocument {
  const raw = text?.trim() ?? "";
  const limited = raw.slice(0, MAX_EXTRACT_CHARS);
  const readRanges: ReadRange[] = limited
    ? [{ kind: "chars", start: 0, end: limited.length }]
    : [];
  return {
    ...(limited ? { text: limited } : {}),
    chars: raw.length,
    truncated: raw.length > MAX_EXTRACT_CHARS,
    pagesProcessed: [],
    readRanges,
    extractor,
    ...(!limited ? { error: "empty" } : {}),
  };
}

function failure(extractor: string, error: string): ExtractedDocument {
  return {
    chars: 0,
    truncated: false,
    pagesProcessed: [],
    readRanges: [],
    extractor,
    error,
  };
}

export async function extractDocument(
  data: Buffer,
  mime: string,
  name?: string,
): Promise<ExtractedDocument> {
  const ext = extension(name, mime);
  if (["txt", "md", "sql", "csv", "json", "log", "yaml", "yml"].includes(ext)) {
    return finish(data.toString("utf8").trim(), "text");
  }
  if (ext === "html" || ext === "htm") {
    const raw = data.toString("utf8");
    const visible = raw
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s{2,}/g, " ")
      .trim();
    const scripts = [...raw.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)]
      .map((match) => match[1] ?? "")
      .join("\n");
    const labels = [...scripts.matchAll(/[\u4e00-\u9fff][\u4e00-\u9fffA-Za-z0-9_（）()：:·/\-、，。！？ ]{0,120}/g)]
      .map((match) => match[0].trim())
      .filter((value) => value.length >= 2);
    const useful = [...new Set(labels)].join("\n");
    const text = `${visible}${useful ? `\n${useful}` : ""}`
      .replace(/\s{2,}/g, " ")
      .trim();
    return finish(text, "html");
  }
  if (["xlsx", "xls"].includes(ext)) {
    try {
      const workbook = XLSX.read(data, { type: "buffer", cellDates: true });
      const lines: string[] = [];
      for (const name of workbook.SheetNames.slice(0, 20)) {
        const sheet = workbook.Sheets[name];
        if (!sheet) continue;
        const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
        if (!csv.trim()) continue;
        lines.push(`### Sheet: ${name}`, csv);
      }
      return finish(lines.join("\n").trim(), "xlsx");
    } catch {
      return failure("xlsx", "extract_failed");
    }
  }
  if (!["docx", "pdf", "doc"].includes(ext)) return failure("none", "unsupported");

  const dir = await mkdtemp(join(tmpdir(), "atme-doc-"));
  const file = join(dir, `document.${ext}`);
  try {
    await writeFile(file, data);
    if (ext === "pdf") {
      return finish(await run("pdftotext", [file, "-"]), "pdftotext");
    }
    if (ext === "doc") {
      return finish(await run("antiword", [file]), "antiword");
    }
    if (ext === "docx") {
      const text = await run("pandoc", [file, "-t", "plain"]);
      if (text) return finish(text, "pandoc");
      const xml = await run("unzip", ["-p", file, "word/document.xml"]);
      if (!xml) return failure("docx", "extract_failed");
      return finish(
        xml
          .replace(/<w:p[^>]*>/g, "\n")
          .replace(/<[^>]+>/g, "")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/\n{3,}/g, "\n\n")
          .trim(),
        "docx-xml",
      );
    }
    return failure("none", "unsupported");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function extractDocumentText(
  data: Buffer,
  mime: string,
  name?: string,
): Promise<string | undefined> {
  return (await extractDocument(data, mime, name)).text;
}
