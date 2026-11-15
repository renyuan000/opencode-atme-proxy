import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OwnerStore } from "../src/core/owner-store.js";

test("persists and reloads owner binding", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-owner-"));
  try {
    const file = join(dir, "owner.json");
    const store = new OwnerStore(file);
    await store.load();
    store.set({
      platform: "feishu",
      openId: "ou_owner",
      displayName: "我",
      boundAt: 1,
      method: "claim",
    });
    await store.flush();
    const reloaded = new OwnerStore(file);
    await reloaded.load();
    assert.equal(reloaded.get("feishu")?.openId, "ou_owner");
    assert.equal(reloaded.get("feishu")?.method, "claim");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("clear removes binding", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-owner-"));
  try {
    const store = new OwnerStore(join(dir, "owner.json"));
    await store.load();
    store.set({ platform: "feishu", openId: "ou_owner", boundAt: 1, method: "config" });
    assert.equal(store.clear("feishu"), true);
    assert.equal(store.get("feishu"), undefined);
    assert.equal(store.clear("feishu"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
