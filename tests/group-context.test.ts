import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GroupContextStore } from "../src/core/group-context.js";

test("persists and reloads group summaries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-group-"));
  try {
    const file = join(dir, "group-context.json");
    const store = new GroupContextStore(file);
    await store.load();
    store.set("feishu:chat", {
      chatId: "feishu:chat",
      summary: "第 3 步要确定过滤 IP 是否入库",
      decisions: ["入库但标记排除"],
      assumptions: ["页面需要展示被过滤项"],
      openQuestions: ["是否需要独立过滤表"],
      lastMessageAt: 1000,
      updatedAt: 1000,
    });
    await store.flush();
    const reloaded = new GroupContextStore(file);
    await reloaded.load();
    const summary = reloaded.get("feishu:chat");
    assert.equal(summary?.summary, "第 3 步要确定过滤 IP 是否入库");
    assert.deepEqual(summary?.decisions, ["入库但标记排除"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
