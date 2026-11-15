import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CursorStore } from "../src/core/cursor.js";
import { PollingService } from "../src/core/poller.js";
import type { PlatformAdapter } from "../src/core/ports.js";
import type { CapabilitySet, IncomingMessage } from "../src/core/types.js";

function message(id: string): IncomingMessage {
  return {
    platform: "test",
    messageId: id,
    chat: { id: "chat1", kind: "group" },
    sender: { platform: "test", id: "u1" },
    senderType: "user",
    text: `text ${id}`,
    mentions: [],
    createdAt: Date.now(),
    rawType: "text",
  };
}

function adapter(history: boolean, fail = false): PlatformAdapter {
  const caps: CapabilitySet = {
    realtimeMentions: true,
    allGroupMessages: false,
    groupHistory: history,
    directMessage: true,
    reply: true,
    interactiveCard: true,
    buttons: true,
    threads: false,
    attachmentsInbound: true,
    identityVerify: true,
  };
  return {
    platform: "test",
    capabilities: () => caps,
    async start() {},
    async stop() {},
    async healthCheck() {
      return { ok: true };
    },
    async listMessages() {
      if (fail) throw new Error("boom");
      return { messages: [message("m1"), message("m2")] };
    },
    async send() {
      return { messageId: "sent" };
    },
    async reply() {
      return { messageId: "replied" };
    },
    renderApproval() {
      return { kind: "text", text: "approval" };
    },
    async verifyActor() {
      return true;
    },
  };
}

test("poll advances cursor after a successful batch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-poll-"));
  try {
    const cursors = new CursorStore({ file: join(dir, "cursors.json") });
    await cursors.load();
    const seen: IncomingMessage[] = [];
    const poller = new PollingService({
      platform: adapter(true),
      cursors,
      groups: [{ chatId: "chat1", enabled: true }],
      intervalMs: 60000,
      overlapMs: 60000,
      lookbackMs: 3600000,
      pageSize: 50,
      maxPages: 5,
      maxMessagesPerRun: 100,
      onBatch: async (messages) => {
        seen.push(...messages);
      },
    });
    await poller.tick();
    assert.equal(seen.length, 2);
    assert.ok((cursors.get("chat1") ?? 0) > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("poll keeps cursor on failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-poll-"));
  try {
    const cursors = new CursorStore({ file: join(dir, "cursors.json") });
    await cursors.load();
    const poller = new PollingService({
      platform: adapter(true, true),
      cursors,
      groups: [{ chatId: "chat1", enabled: true }],
      intervalMs: 60000,
      overlapMs: 60000,
      lookbackMs: 3600000,
      pageSize: 50,
      maxPages: 5,
      maxMessagesPerRun: 100,
      onBatch: async () => {},
    });
    await poller.tick();
    assert.equal(cursors.get("chat1"), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("poll does nothing when platform lacks history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-poll-"));
  try {
    const cursors = new CursorStore({ file: join(dir, "cursors.json") });
    await cursors.load();
    let called = false;
    const poller = new PollingService({
      platform: adapter(false),
      cursors,
      groups: [{ chatId: "chat1", enabled: true }],
      intervalMs: 60000,
      overlapMs: 60000,
      lookbackMs: 3600000,
      pageSize: 50,
      maxPages: 5,
      maxMessagesPerRun: 100,
      onBatch: async () => {
        called = true;
      },
    });
    poller.start();
    poller.stop();
    assert.equal(called, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
