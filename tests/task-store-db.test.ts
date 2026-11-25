import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskStore } from "../src/core/task-store.js";
import type { TaskRecord } from "../src/core/types.js";

function task(id: string): TaskRecord {
  return {
    id,
    platform: "feishu",
    chatId: "chat",
    messageIds: ["m1"],
    source: "mention_me",
    requester: { platform: "feishu", id: "u1" },
    title: "test",
    excerpt: "test",
    keywords: [],
    relevance: { reason: "test", confidence: 1 },
    dedupKey: `dedup:${id}`,
    state: "needs_info",
    createdAt: 1,
    updatedAt: 1,
  };
}

test("stores task snapshots in sqlite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-task-store-"));
  try {
    const dbPath = join(dir, "cache", "state.db");
    const store = new TaskStore(dir, undefined, dbPath);
    await store.load();
    await store.save(task("task_1"));
    await store.save(task("task_2"));
    assert.equal((await store.list()).length, 2);
    assert.equal((await store.get("task_1"))?.title, "test");
    assert.equal(store.findByDedupKey("dedup:task_1"), "task_1");
    await store.close();

    const reopened = new TaskStore(dir, undefined, dbPath);
    await reopened.load();
    assert.equal((await reopened.list()).length, 2);
    assert.equal((await reopened.get("task_2"))?.id, "task_2");
    await reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
