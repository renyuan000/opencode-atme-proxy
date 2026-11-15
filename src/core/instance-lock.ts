import { open, readFile, unlink, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "./logger.js";
import { createLogger } from "./logger.js";
import { toErrorMessage } from "./util.js";

export async function acquireInstanceLock(path: string, logger?: Logger): Promise<void> {
  const log = logger ?? createLogger({ scope: "lock" });
  await mkdir(dirname(path), { recursive: true });
  try {
    const handle = await open(path, "wx", 0o600);
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      "utf8",
    );
    await handle.close();
    return;
  } catch (error) {
    if (!isExists(error)) throw error;
  }

  const existing = await readLock(path);
  if (existing && isProcessAlive(existing.pid)) {
    throw new Error(`another instance is running (pid ${existing.pid})`);
  }
  log.warn("removing stale instance lock", { path, stalePid: existing?.pid });
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const handle = await open(path, "wx", 0o600);
  await handle.writeFile(
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    "utf8",
  );
  await handle.close();
}

export async function releaseInstanceLock(path: string, logger?: Logger): Promise<void> {
  const log = logger ?? createLogger({ scope: "lock" });
  try {
    const existing = await readLock(path);
    if (existing?.pid !== process.pid) return;
    await unlink(path);
  } catch (error) {
    if (!isMissing(error)) {
      log.warn("failed to release instance lock", { error: toErrorMessage(error) });
    }
  }
}

async function readLock(path: string): Promise<{ pid: number; startedAt?: string } | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as { pid?: unknown; startedAt?: unknown };
    if (typeof parsed.pid === "number") return { pid: parsed.pid, ...(typeof parsed.startedAt === "string" ? { startedAt: parsed.startedAt } : {}) };
    return undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isMissing(error) && !isInvalid(error);
  }
}

function isExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "EEXIST";
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

function isInvalid(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ESRCH";
}
