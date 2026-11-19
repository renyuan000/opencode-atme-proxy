import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function readGroupStateFile(stateDir: string, filename: string): Promise<string> {
  const root = join(stateDir, "groups");
  const dirs = await readdir(root, { withFileTypes: true });
  for (const dir of dirs) {
    if (!dir.isDirectory() || dir.name.startsWith("_")) continue;
    try {
      return await readFile(join(root, dir.name, filename), "utf8");
    } catch {
      continue;
    }
  }
  throw new Error(`group state file not found: ${filename}`);
}

export function testGroupDir(stateDir: string, chatId: string, name?: string): string {
  const short = chatId.slice(0, 11);
  const display = name ?? (chatId === "p2p" ? "私聊" : `群_${short}`);
  const safe = display.replace(/[/\\:*?"<>|]/g, "_").slice(0, 40);
  return join(stateDir, "groups", `${safe}__${short}`);
}

export async function ensureTestGroup(stateDir: string, chatId: string, name?: string): Promise<string> {
  const dir = testGroupDir(stateDir, chatId, name);
  await mkdir(dir, { recursive: true });
  const groupJson = join(dir, "group.json");
  if (!(await readFile(groupJson, "utf8").catch(() => ""))) {
    await writeFile(groupJson, JSON.stringify({
      groupKey: `feishu:${chatId}`,
      chatId,
      name: name ?? (chatId === "p2p" ? "私聊" : `群_${chatId.slice(0, 11)}`),
      dirName: dir.split("/").pop(),
    }));
  }
  return dir;
}

export async function writeGroupStateFile(
  stateDir: string,
  chatId: string,
  filename: string,
  content: string,
): Promise<void> {
  const dir = await ensureTestGroup(stateDir, chatId);
  await writeFile(join(dir, filename), content);
}
