import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function ocrImage(data: Buffer, mime: string): Promise<string | undefined> {
  const dir = await mkdtemp(join(tmpdir(), "atme-ocr-"));
  const ext = mime.includes("jpeg") || mime.includes("jpg") ? ".jpg" : ".png";
  const file = join(dir, `image${ext}`);
  try {
    await writeFile(file, data);
    const { stdout } = await execFileAsync(
      "tesseract",
      [file, "stdout", "-l", "chi_sim+eng", "--psm", "6"],
      { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 },
    );
    const text = String(stdout ?? "").trim();
    return text || undefined;
  } catch {
    return undefined;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
