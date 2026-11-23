import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DmContextStore } from "../src/core/dm-context.js";

test("persists dm summary, preferences, and epoch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-dm-context-"));
  try {
    const file = join(dir, "dm-context.json");
    const store = new DmContextStore(file);
    await store.load();
    store.set({
      chatId: "dm",
      summary: "owner 偏好在群里先给结论",
      preferences: ["先结论后展开"],
      decisions: ["默认不自动发群"],
      ongoingGoals: ["长期维护资产测绘群"],
      openQuestions: ["微信接入时间"],
      lastMessageAt: 1,
      updatedAt: 1,
      sessionEpoch: 2,
    });
    await store.flush();

    const reloaded = new DmContextStore(file);
    await reloaded.load();
    const context = reloaded.get("dm");
    assert.equal(context?.summary, "owner 偏好在群里先给结论");
    assert.deepEqual(context?.preferences, ["先结论后展开"]);
    assert.equal(context?.sessionEpoch, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
