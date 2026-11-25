import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskLinkStore } from "../src/core/task-links.js";

test("persists message and session task links", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-task-links-"));
  try {
    const path = join(dir, "cache", "task-links.json");
    const store = new TaskLinkStore(path);
    await store.load();
    await store.linkMessage("om_card", "task_1");
    await store.linkSession("ses_1", "task_1", "analysis");
    assert.equal(store.findByMessage("om_card"), "task_1");
    assert.deepEqual(store.findBySession("ses_1"), { taskId: "task_1", role: "analysis" });

    const reloaded = new TaskLinkStore(path);
    await reloaded.load();
    assert.equal(reloaded.findByMessage("om_card"), "task_1");
    assert.equal(reloaded.findBySession("ses_1")?.taskId, "task_1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
