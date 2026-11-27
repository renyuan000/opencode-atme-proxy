import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EvidenceStore } from "../src/core/evidence-store.js";

function stamp(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
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
    await store.append({
      ts: now,
      platform: "feishu",
      chatId: "oc_1",
      chatName: "产品/流分",
      messageId: "m1",
      replyToMessageId: "m-parent",
      threadId: "thread-1",
      direction: "inbound",
      text: "这是一条很长的消息".repeat(5),
    });
    const file = join(dir, "产品_流分__oc_1", `${stamp(now)}.jsonl`);
    const raw = await readFile(file, "utf8");
    const record = JSON.parse(raw.trim()) as { text: string; direction: string; replyToMessageId?: string; threadId?: string };
    assert.equal(record.direction, "inbound");
    assert.equal(record.replyToMessageId, "m-parent");
    assert.equal(record.threadId, "thread-1");
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
    await store.append({ ts: now, platform: "feishu", chatId: "oc_1", messageId: "m1", direction: "inbound", senderName: "任元", text: "第 3 步：过滤 IP 是否入库" });
    await store.append({ ts: now, platform: "feishu", chatId: "oc_1", messageId: "m2", direction: "inbound", senderName: "杨丰印", text: "午饭吃什么" });
    const found = await store.search({ chatId: "oc_1", terms: ["过滤"], days: 7, limit: 5 });
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
    await store.append({
      ts: now,
      platform: "feishu",
      chatId: "oc_1",
      messageId: "m1",
      direction: "inbound",
      text: "旧消息",
    });
    now += 62 * 86_400_000;
    await store.prune();
    const file = join(dir, "群__oc_1", `${stamp(now - 62 * 86_400_000)}.jsonl`);
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
    await store.append({
      ts: now,
      platform: "feishu",
      chatId: "oc_1",
      messageId: "m-parent",
      direction: "inbound",
      senderName: "任元",
      text: "父消息：操作日志按类型分组",
    });
    assert.equal((await store.findByMessageId({ chatId: "oc_1", messageId: "m-parent" }))?.text, "父消息：操作日志按类型分组");
    await store.append({
      ts: now,
      platform: "feishu",
      chatId: "oc_1",
      messageId: "m-child",
      replyToMessageId: "m-parent",
      threadId: "thread-1",
      direction: "inbound",
      text: "子消息",
    });
    await store.append({
      ts: now + 1000,
      platform: "feishu",
      chatId: "oc_1",
      messageId: "m-sibling",
      threadId: "thread-1",
      direction: "inbound",
      text: "同线程消息",
    });
    const chain = await store.findReplyChain({ chatId: "oc_1", messageId: "m-child" });
    assert.deepEqual(chain.map((item) => item.messageId), ["m-child", "m-parent"]);
    const mixed = await store.findMessageChain({ chatId: "oc_1", messageId: "m-child" });
    assert.deepEqual(mixed.reply.map((item) => item.messageId), ["m-child", "m-parent"]);
    assert.deepEqual(mixed.thread.map((item) => item.messageId), ["m-sibling"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
