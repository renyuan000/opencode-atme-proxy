import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChatContextStore } from "../src/core/chat-context.js";

test("appends, caps, and returns recent context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-ctx-"));
  try {
    const store = new ChatContextStore({
      file: join(dir, "chat-context.json"),
      maxMessagesPerChat: 3,
      maxCharsPerMessage: 10,
      maxChats: 10,
      ttlMs: 86_400_000,
    });
    await store.load();
    for (let i = 0; i < 5; i++) {
      store.append("feishu:chat", {
        messageId: `m${i}`,
        senderId: "u",
        text: `message number ${i} with long tail`,
        at: Date.now(),
        mentionMe: false,
        mentionBot: false,
      });
    }
    const recent = store.recent("feishu:chat", 10);
    assert.equal(recent.length, 3);
    assert.equal(recent[0]?.messageId, "m2");
    assert.equal(recent[2]?.messageId, "m4");
    assert.ok((recent[0]?.text.length ?? 0) <= 11);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("excludes current message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-ctx-"));
  try {
    const store = new ChatContextStore({
      file: join(dir, "chat-context.json"),
      maxMessagesPerChat: 10,
      maxCharsPerMessage: 100,
      maxChats: 10,
      ttlMs: 86_400_000,
    });
    await store.load();
    store.append("c", { messageId: "m1", senderId: "u", text: "a", at: 1, mentionMe: false, mentionBot: false });
    store.append("c", { messageId: "m2", senderId: "u", text: "b", at: 2, mentionMe: false, mentionBot: false });
    assert.deepEqual(store.recent("c", 10, "m2").map((m) => m.messageId), ["m1"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("prunes expired chats and caps chat count", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-ctx-"));
  try {
    let now = 1000;
    const store = new ChatContextStore({
      file: join(dir, "chat-context.json"),
      maxMessagesPerChat: 10,
      maxCharsPerMessage: 100,
      maxChats: 2,
      ttlMs: 1000,
      now: () => now,
    });
    await store.load();
    for (const chat of ["a", "b", "c"]) {
      now += 1;
      store.append(chat, { messageId: `m-${chat}`, senderId: "u", text: "x", at: now, mentionMe: false, mentionBot: false });
    }
    assert.equal(store.get("a"), undefined);
    assert.ok(store.get("c"));
    now += 2000;
    store.prune();
    assert.equal(store.get("c"), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
