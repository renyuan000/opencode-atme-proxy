import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryStore } from "../src/core/memory-store.js";

async function store(dir: string, now?: () => number): Promise<MemoryStore> {
  const s = new MemoryStore({
    file: join(dir, "memory.json"),
    maxEntries: 100,
    ttlMs: 86_400_000,
    pinnedKinds: ["task", "decision", "deadline"],
    ...(now ? { now } : {}),
  });
  await s.load();
  return s;
}

test("upsert dedupes by key and preserves source ids", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-memory-"));
  try {
    const s = await store(dir);
    s.upsert({
      platform: "feishu",
      kind: "task",
      key: "task:1",
      value: "补文档",
      chatId: "chat",
      sourceMessageIds: ["m1"],
    });
    s.upsert({
      platform: "feishu",
      kind: "task",
      key: "task:1",
      value: "补文档并上线",
      chatId: "chat",
      sourceMessageIds: ["m2"],
    });
    const result = s.query({ platform: "feishu", chatId: "chat", limit: 10 });
    assert.equal(result.length, 1);
    assert.equal(result[0]?.value, "补文档并上线");
    assert.deepEqual(result[0]?.sourceMessageIds, ["m1", "m2"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("query prefers chat/project and keyword matches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-memory-"));
  try {
    const s = await store(dir);
    s.upsert({ platform: "feishu", kind: "fact", key: "a", value: "支付灰度用 5%", chatId: "chat1", projectId: "pay" });
    s.upsert({ platform: "feishu", kind: "fact", key: "b", value: "无关内容", chatId: "chat2", projectId: "other" });
    const result = s.query({ platform: "feishu", chatId: "chat1", projectId: "pay", text: "灰度", limit: 5 });
    assert.equal(result[0]?.key, "a");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pinned records survive ttl and are never evicted first", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-memory-"));
  try {
    let now = 1000;
    const s = await store(dir, () => now);
    s.upsert({ platform: "feishu", kind: "task", key: "pin", value: "important" });
    s.upsert({ platform: "feishu", kind: "fact", key: "temp", value: "temporary", ttlMs: 1000 });
    now = 5000;
    s.prune();
    assert.ok(s.query({ platform: "feishu", limit: 10 }).some((r) => r.key === "pin"));
    assert.ok(!s.query({ platform: "feishu", limit: 10 }).some((r) => r.key === "temp"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("persists and reloads records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-memory-"));
  try {
    const s = await store(dir);
    s.upsert({ platform: "feishu", kind: "decision", key: "d1", value: "先做灰度", chatId: "chat" });
    await s.flush();
    const reloaded = await store(dir);
    const result = reloaded.query({ platform: "feishu", chatId: "chat", limit: 5 });
    assert.equal(result[0]?.value, "先做灰度");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
