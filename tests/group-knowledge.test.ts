import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GroupStateLayout } from "../src/core/group-state.js";
import { ScopedGroupKnowledge } from "../src/core/group-knowledge.js";

test("migrates legacy group knowledge and persists terms/epoch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-knowledge-"));
  try {
    const layout = new GroupStateLayout(join(dir, "groups"));
    await layout.load();
    const info = await layout.ensure("chat", "资产测绘");
    await writeFile(
      join(info.dir, "group-profile.json"),
      JSON.stringify({
        chatId: "chat",
        name: "资产测绘",
        product: "资产测绘",
        summary: "旧画像",
        features: ["指纹"],
        tasks: [],
        dependsOn: ["npb-engine"],
        excludes: [],
        source: "owner",
        confidence: 1,
        updatedAt: 1,
      }),
    );

    const store = new ScopedGroupKnowledge(layout);
    await store.load();
    const loaded = store.get("chat");
    assert.equal(loaded?.summary, "旧画像");
    assert.deepEqual(loaded?.terms, {});
    assert.equal(loaded?.sessionEpoch, 1);

    await store.set({
      ...loaded!,
      terms: { 指纹: "资产指纹识别" },
      sessionEpoch: 2,
      updatedAt: 2,
    });
    const reloaded = new ScopedGroupKnowledge(layout);
    await reloaded.load();
    assert.equal(reloaded.get("chat")?.terms["指纹"], "资产指纹识别");
    assert.equal(reloaded.get("chat")?.sessionEpoch, 2);
    assert.equal(await reloaded.bumpSessionEpoch("chat"), 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
