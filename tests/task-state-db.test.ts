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
    db.recordNotification({
      taskId: "task_1",
      chatId: "chat",
      kind: "candidate",
      title: "候选任务",
      summary: "test",
      cardMessageId: "om_card",
      sourceMessageId: "om_source",
    });
    assert.equal(db.recentNotifications(1)[0]?.taskId, "task_1");
    assert.equal(db.notificationsForTask("task_1")[0]?.cardMessageId, "om_card");
    const run = db.startRun({ taskId: "task_1", chatId: "chat", role: "analysis", stage: "analyzing" });
    assert.equal(db.currentRun("task_1")?.id, run.id);
    db.attachRunSession(run.id, "ses_1");
    assert.equal(db.currentRun("task_1")?.sessionId, "ses_1");
    db.finishRun(run.id, "awaiting_approval");
    assert.equal(db.currentRun("task_1")?.status, "awaiting_approval");
    db.saveTaskWithLinks(
      "task_2",
      JSON.stringify({ id: "task_2", state: "needs_info", updatedAt: Date.now() }),
      Date.now(),
      "dedup_2",
      ["om_active"],
    );
    db.saveTaskWithLinks(
      "task_3",
      JSON.stringify({ id: "task_3", state: "done", archivedAt: Date.now() }),
      Date.now(),
      "dedup_3",
      ["om_archived"],
    );
    const cleaned = db.cleanup({ linkDays: -1, eventDays: -1 });
    assert.equal(cleaned.links, 1);
    assert.equal(db.findByMessage("om_active"), "task_2");
    assert.equal(db.findByMessage("om_archived"), undefined);
    assert.equal(db.findByMessage("om_card"), "task_1");
    assert.deepEqual(db.findBySession("ses_1"), { taskId: "task_1", role: "analysis" });
    db.linkSession("ses_1", "task_2", "analysis");
    assert.deepEqual(db.findByTask("task_1"), [{ sessionId: "ses_1", role: "analysis" }]);
    assert.deepEqual(db.findByTask("task_2"), [{ sessionId: "ses_1", role: "analysis" }]);
    db.close();

    const reopened = new TaskStateDb(path, "chat");
    assert.equal(reopened.findByMessage("om_card"), "task_1");
    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
