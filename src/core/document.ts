import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

export async function extractDocumentText(
  data: Buffer,
  mime: string,
  name?: string,
): Promise<string | undefined> {
  const ext = extension(name, mime);
  if (["txt", "md", "sql", "csv", "json", "log", "yaml", "yml"].includes(ext)) {
    return data.toString("utf8").trim().slice(0, 20_000) || undefined;
  }
  if (ext === "html" || ext === "htm") {
    return data
      .toString("utf8")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s{2,}/g, " ")
      .trim()
      .slice(0, 20_000) || undefined;
  }
  if (!["docx", "pdf", "doc"].includes(ext)) return undefined;

  const dir = await mkdtemp(join(tmpdir(), "atme-doc-"));
  const file = join(dir, `document.${ext}`);
  try {
    await writeFile(file, data);
    if (ext === "pdf") {
      const text = await run("pdftotext", [file, "-"]);
      return text?.slice(0, 20_000);
    }
    if (ext === "docx") {
      const text = await run("pandoc", [file, "-t", "plain"]);
      if (text) return text.slice(0, 20_000);
      const xml = await run("unzip", ["-p", file, "word/document.xml"]);
      if (!xml) return undefined;
      return xml
        .replace(/<w:p[^>]*>/g, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, 20_000);
    }
    return undefined;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
