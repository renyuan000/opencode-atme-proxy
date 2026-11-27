#!/usr/bin/env node
process.stdout.on("error", (error) => {
  if (error?.code === "EPIPE") process.exit(0);
  throw error;
});
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const command = args[0] ?? "plan";
const options = {};
for (let index = 0; index < args.length; index += 1) {
  const value = args[index];
  if (!value.startsWith("--")) continue;
  const key = value.slice(2);
  const next = args[index + 1];
  if (next && !next.startsWith("--")) {
    options[key] = next;
    index += 1;
  } else {
    options[key] = true;
  }
}
if (options.help || command === "help") {
  console.log(`用法：
  node scripts/session-cleanup.mjs plan [选项]
  node scripts/session-cleanup.mjs apply --plan-file <文件> [选项]

选项：
  --directory <目录>             OpenCode 项目目录，默认当前目录
  --base-url <URL>               默认 http://127.0.0.1:19876
  --min-age-minutes <分钟>       候选最小年龄，默认 60；0 表示全部列出
  --plan-file <文件>             默认 /tmp/opencode/atme-session-cleanup-plan.json
  --yes                          真正执行删除；没有该参数只模拟
  --all                          等价于 --min-age-minutes 0，仅用于查看全部
  --include-old-protected        允许将旧的非当前持久 session 列为候选（默认不列）
  --max-count <数量>             最多列出多少个 session，默认 500

默认只把“0 消息、超过最小年龄、且不是持久角色”的会话列为候选，因此默认可能没有候选。
使用 --include-old-protected 时，只允许旧的非当前持久 session；同标题最新 session 始终保护。
`);
  process.exit(0);
}
if (!["plan", "apply"].includes(command)) {
  console.error(`未知命令：${command}`);
  process.exit(2);
}

let directory = resolve(String(options.directory ?? process.cwd()));
const baseUrl = String(options["base-url"] ?? "http://127.0.0.1:19876").replace(/\/+$/, "");
const minAgeMinutes = options.all ? 0 : Math.max(0, Number(options["min-age-minutes"] ?? 60));
const maxCount = Math.max(1, Number(options["max-count"] ?? 500));
const planFile = String(options["plan-file"] ?? "/tmp/opencode/atme-session-cleanup-plan.json");
const persistentPrefixes = [
  "atme:chat:",
  "atme:group:",
  "atme:worker:",
  "atme:dm-summary:",
  "atme:analysis-check:",
  "atme:exec:",
];

function atmeTitle(session) {
  return typeof session.title === "string" && session.title.startsWith("atme:");
}

function isPersistent(title) {
  return persistentPrefixes.some((prefix) => title.startsWith(prefix));
}

function textOfParts(message) {
  const parts = message?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchMessages(id) {
  const url = `${baseUrl}/session/${encodeURIComponent(id)}/message?directory=${encodeURIComponent(directory)}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  return Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
}

function listSessions() {
  const result = spawnSync(
    "opencode",
    ["session", "list", "-n", String(maxCount), "--format", "json"],
    { cwd: directory, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `opencode exited ${result.status}`);
  }
  const parsed = JSON.parse(result.stdout || "[]");
  if (!Array.isArray(parsed)) throw new Error("opencode session list did not return an array");
  return parsed;
}

function latestByTitle(sessions) {
  const latest = new Map();
  for (const session of sessions) {
    if (!atmeTitle(session)) continue;
    const current = latest.get(session.title);
    if (!current || Number(session.updated ?? 0) > Number(current.updated ?? 0)) {
      latest.set(session.title, session);
    }
  }
  return latest;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function printRow(item) {
  const kind = item.reason.padEnd(18);
  const title = truncate(item.title, 52).padEnd(52);
  const preview = truncate(item.preview || "-", 42);
  console.log(
    `${kind} ${String(item.messageCount).padStart(2)} ${formatBytes(item.bytes).padStart(7)} ${item.id}  ${title}  ${preview}`,
  );
}

function truncate(value, max) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

async function createPlan() {
  const sessions = listSessions().filter(atmeTitle);
  const latest = latestByTitle(sessions);
  const now = Date.now();
  const items = [];
  for (const session of sessions) {
    let messages = [];
    try {
      messages = await fetchMessages(session.id);
    } catch (error) {
      items.push({
        id: session.id,
        title: session.title,
        updated: Number(session.updated ?? 0),
        messageCount: -1,
        bytes: 0,
        preview: `读取失败：${error instanceof Error ? error.message : String(error)}`,
        reason: "read-error",
      });
      continue;
    }
    const count = messages.length;
    const text = messages.map(textOfParts).filter(Boolean).join(" / ");
    const bytes = Buffer.byteLength(JSON.stringify(messages), "utf8");
    const ageMinutes = (now - Number(session.updated ?? 0)) / 60_000;
    const latestForTitle = latest.get(session.title);
    const isPersistentTitle = isPersistent(session.title);
    const isLatestPersistent = isPersistentTitle && latestForTitle?.id === session.id;
    const allowOldProtected = Boolean(options["include-old-protected"]);
    const protectedRole = isPersistentTitle && (!allowOldProtected || isLatestPersistent);
    const recent = ageMinutes < minAgeMinutes;
    const reason = count !== 0
      ? "nonempty"
      : recent
        ? "recent"
        : isLatestPersistent
          ? "protected-current"
          : protectedRole
            ? "protected-role"
            : "candidate";
    items.push({
      id: session.id,
      title: session.title,
      updated: Number(session.updated ?? 0),
      messageCount: count,
      bytes,
      preview: text,
      reason,
    });
  }
  items.sort((a, b) => {
    const rank = {
      candidate: 0,
      nonempty: 1,
      recent: 2,
      "protected-current": 3,
      "protected-role": 4,
      "read-error": 5,
    };
    return (rank[a.reason] ?? 9) - (rank[b.reason] ?? 9) || a.title.localeCompare(b.title);
  });
  console.log(`目录：${directory}`);
  console.log(`atme session：${items.length}，候选空 session：${items.filter((item) => item.reason === "candidate").length}`);
  console.log("状态             条数    字节       sessionId  标题  内容预览");
  for (const item of items) printRow(item);
  const candidates = items.filter((item) => item.reason === "candidate");
  await writeFile(
    planFile,
    `${JSON.stringify({ version: 1, directory, baseUrl, generatedAt: now, minAgeMinutes, candidates }, null, 2)}\n`,
    "utf8",
  );
  console.log(`\n计划文件：${planFile}`);
  console.log("默认只生成计划，不删除。持久角色 session 即使为空也不会被列为候选。");
}

async function applyPlan() {
  const raw = await readFile(planFile, "utf8");
  const plan = JSON.parse(raw);
  if (!options.directory && plan.directory) directory = resolve(plan.directory);
  if (plan.directory && resolve(plan.directory) !== directory) {
    throw new Error(`计划目录不匹配：${plan.directory} != ${directory}`);
  }
  const candidates = Array.isArray(plan.candidates) ? plan.candidates : [];
  const planMinAge = Number(plan.minAgeMinutes ?? minAgeMinutes);
  if (options.yes && planMinAge < 1) {
    throw new Error("拒绝执行：计划使用 min-age=0；请至少设置 1 分钟后重新生成计划");
  }
  if (candidates.length === 0) {
    console.log("计划中没有候选 session。");
    return;
  }
  const sessions = listSessions().filter(atmeTitle);
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const latest = latestByTitle(sessions);
  const now = Date.now();
  const minAge = Number(plan.minAgeMinutes ?? minAgeMinutes);
  let deleted = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    const session = byId.get(candidate.id);
    if (!session || !atmeTitle(session)) {
      console.log(`skip  ${candidate.id}：session 不存在或标题已变化`);
      skipped += 1;
      continue;
    }
    const latestForTitle = latest.get(session.title);
    if (isPersistent(session.title) && (!options["include-old-protected"] || latest.get(session.title)?.id === session.id)) {
      console.log(`skip  ${session.id}：持久角色 session 默认不删除`);
      skipped += 1;
      continue;
    }
    if ((now - Number(session.updated ?? 0)) / 60_000 < minAge) {
      console.log(`skip  ${session.id}：最近仍有更新`);
      skipped += 1;
      continue;
    }
    let messages;
    try {
      messages = await fetchMessages(session.id);
    } catch (error) {
      console.log(`skip  ${session.id}：读取失败 ${error instanceof Error ? error.message : String(error)}`);
      skipped += 1;
      continue;
    }
    if (messages.length !== 0) {
      console.log(`skip  ${session.id}：现有 ${messages.length} 条消息，不是空 session`);
      skipped += 1;
      continue;
    }
    if (!options.yes) {
      console.log(`would delete ${session.id}  ${session.title}`);
      continue;
    }
    const result = spawnSync("opencode", ["session", "delete", session.id], {
      cwd: directory,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    if (result.status === 0) {
      console.log(`deleted ${session.id}  ${session.title}`);
      deleted += 1;
    } else {
      console.log(`failed  ${session.id}  ${result.stderr || result.stdout || `exit ${result.status}`}`);
      skipped += 1;
    }
  }
  if (!options.yes) {
    console.log("\n这是模拟结果。确认无误后加 --yes 再执行。");
  } else {
    console.log(`\n完成：删除 ${deleted}，跳过 ${skipped}`);
  }
}

try {
  if (command === "plan") await createPlan();
  else await applyPlan();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
