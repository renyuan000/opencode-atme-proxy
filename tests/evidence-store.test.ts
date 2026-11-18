import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EvidenceStore } from "../src/core/evidence-store.js";

function stamp(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

test("writes inbound evidence and truncates long text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-evidence-"));
  try {
    const now = new Date(2026, 10, 17, 12, 0, 0).getTime();
    const store = new EvidenceStore({
      dir,
      retentionDays: 720,
      maxChars: 20,
      now: () => now,
    });
    store.append({
      ts: now,
      platform: "feishu",
      chatId: "oc_1",
      chatName: "产品/流分",
      messageId: "m1",
      direction: "inbound",
      text: "这是一条很长的消息".repeat(5),
    });
    const file = join(dir, "产品_流分__oc_1", `${stamp(now)}.jsonl`);
    const raw = await readFile(file, "utf8");
    const record = JSON.parse(raw.trim()) as { text: string; direction: string };
    assert.equal(record.direction, "inbound");
    assert.ok(record.text.includes("…[截断]…"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("searches evidence by term", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-evidence-"));
  try {
    const now = new Date(2026, 10, 17, 12, 0, 0).getTime();
    const store = new EvidenceStore({ dir, retentionDays: 30, maxChars: 200, now: () => now });
    store.append({ ts: now, platform: "feishu", chatId: "oc_1", messageId: "m1", direction: "inbound", senderName: "任元", text: "第 3 步：过滤 IP 是否入库" });
    store.append({ ts: now, platform: "feishu", chatId: "oc_1", messageId: "m2", direction: "inbound", senderName: "杨丰印", text: "午饭吃什么" });
    const found = store.search({ chatId: "oc_1", terms: ["过滤"], days: 7, limit: 5 });
    assert.equal(found.length, 1);
    assert.equal(found[0]?.messageId, "m1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("prunes evidence older than retention", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-evidence-"));
  try {
    let now = new Date(2026, 10, 17, 12, 0, 0).getTime();
    const store = new EvidenceStore({
      dir,
      retentionDays: 30,
      maxChars: 100,
      now: () => now,
    });
    store.append({
      ts: now,
      platform: "feishu",
      chatId: "oc_1",
      messageId: "m1",
      direction: "inbound",
      text: "旧消息",
    });
    now += 31 * 86_400_000;
    store.prune();
    const file = join(dir, "群__oc_1", `${stamp(now - 31 * 86_400_000)}.jsonl`);
    await assert.rejects(readFile(file, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("finds a quoted message by id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-evidence-"));
  try {
    const now = new Date(2026, 10, 17, 12, 0, 0).getTime();
    const store = new EvidenceStore({ dir, retentionDays: 30, maxChars: 200, now: () => now });
    store.append({
      ts: now,
      platform: "feishu",
      chatId: "oc_1",
      messageId: "m-parent",
      direction: "inbound",
      senderName: "任元",
      text: "父消息：操作日志按类型分组",
    });
    assert.equal(store.findByMessageId({ chatId: "oc_1", messageId: "m-parent" })?.text, "父消息：操作日志按类型分组");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
