import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskStateDb } from "../src/core/task-state-db.js";

test("stores task links and events in sqlite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-task-state-"));
  try {
    const path = join(dir, "cache", "state.db");
    const db = new TaskStateDb(path, "chat");
    db.linkMessage("om_card", "task_1");
    db.linkSession("ses_1", "task_1", "analysis");
    db.publish({
      eventId: "e1",
      type: "task.created",
      taskId: "task_1",
      chatId: "chat",
      at: Date.now(),
      payload: { source: "test" },
    });
    assert.equal(db.findByMessage("om_card"), "task_1");
    assert.deepEqual(db.findBySession("ses_1"), { taskId: "task_1", role: "analysis" });
    assert.deepEqual(db.findByTask("task_1"), [{ sessionId: "ses_1", role: "analysis" }]);
    db.close();

    const reopened = new TaskStateDb(path, "chat");
    assert.equal(reopened.findByMessage("om_card"), "task_1");
    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
