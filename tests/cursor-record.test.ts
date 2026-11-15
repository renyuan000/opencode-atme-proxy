import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CursorStore } from "../src/core/cursor.js";

test("cursor stores time and last message id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-cursor-"));
  try {
    const file = join(dir, "cursors.json");
    const store = new CursorStore({ file });
    await store.load();
    store.set("chat", 1000, { messageId: "om_last", messageTime: 900 });
    await store.flush();
    const reloaded = new CursorStore({ file });
    await reloaded.load();
    const record = reloaded.record("chat");
    assert.equal(record?.lastEndTime, 1000);
    assert.equal(record?.lastMessageId, "om_last");
    assert.equal(record?.lastMessageTime, 900);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cursor preserves last message when advancing without a new one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-cursor-"));
  try {
    const store = new CursorStore({ file: join(dir, "cursors.json") });
    await store.load();
    store.set("chat", 1000, { messageId: "om_last", messageTime: 900 });
    store.set("chat", 2000);
    const record = store.record("chat");
    assert.equal(record?.lastEndTime, 2000);
    assert.equal(record?.lastMessageId, "om_last");
    assert.equal(record?.lastMessageTime, 900);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
