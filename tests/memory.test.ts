import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
    requireSource: false,
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

test("same key in different chats stays isolated", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-memory-"));
  try {
    const s = await store(dir);
    s.upsert({ platform: "feishu", kind: "fact", key: "表名", value: "chat1 的表", chatId: "chat1" });
    s.upsert({ platform: "feishu", kind: "fact", key: "表名", value: "chat2 的表", chatId: "chat2" });
    const one = s.query({ platform: "feishu", chatId: "chat1", limit: 10 });
    const two = s.query({ platform: "feishu", chatId: "chat2", limit: 10 });
    assert.equal(one.length, 1);
    assert.equal(one[0]?.value, "chat1 的表");
    assert.equal(two.length, 1);
    assert.equal(two[0]?.value, "chat2 的表");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chatless memory does not leak into chat queries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-memory-"));
  try {
    const s = await store(dir);
    s.upsert({ platform: "feishu", kind: "fact", key: "global", value: "全局记忆" });
    s.upsert({ platform: "feishu", kind: "fact", key: "local", value: "本群记忆", chatId: "chat1" });
    const result = s.query({ platform: "feishu", chatId: "chat1", limit: 10 });
    assert.deepEqual(result.map((item) => item.key), ["local"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects writes without source ids when required", () => {
  const s = new MemoryStore({
    file: "/tmp/atme-memory-source.json",
    maxEntries: 10,
    ttlMs: 86_400_000,
    pinnedKinds: ["task", "decision", "deadline"],
  });
  assert.throws(
    () => s.upsert({ platform: "feishu", kind: "fact", key: "k", value: "v" }),
    /sourceMessageIds/,
  );
});

test("writes per-chat records and history shards", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-memory-"));
  try {
    const s = new MemoryStore({
      file: join(dir, "memory.json"),
      shardDir: join(dir, "memory"),
      maxEntries: 100,
      ttlMs: 86_400_000,
      pinnedKinds: ["task", "decision", "deadline"],
      requireSource: true,
    });
    await s.load();
    s.upsert({
      platform: "feishu",
      chatId: "chat1",
      kind: "fact",
      key: "表名",
      value: "asset_account",
      sourceMessageIds: ["m1"],
    });
    await s.flush();
    const records = JSON.parse(
      await readFile(join(dir, "memory", "chat1", "records.json"), "utf8"),
    ) as { records: Record<string, unknown> };
    assert.equal(Object.keys(records.records).length, 1);
    const historyDir = join(dir, "memory", "chat1", "history");
    const files = await readFile(join(historyDir, `${new Date().toISOString().slice(0, 10)}.jsonl`), "utf8");
    assert.ok(files.includes("asset_account"));
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
