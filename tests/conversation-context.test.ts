import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GroupStateLayout, ScopedChatContext } from "../src/core/group-state.js";

test("chat context is written under the conversation key and remains readable by legacy key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-conv-context-"));
  try {
    const layout = new GroupStateLayout(join(dir, "groups"));
    await layout.load();
    await layout.ensure("chat", "群", {
      conversationId: "feishu:cli_a:group:chat",
    });
    const context = new ScopedChatContext(layout, {
      maxMessagesPerChat: 20,
      maxCharsPerMessage: 300,
      maxChats: 10,
      ttlMs: 60_000,
    });
    context.append(
      "feishu:chat",
      {
        messageId: "m1",
        senderId: "u1",
        text: "hello",
        at: 1,
        mentionMe: false,
        mentionBot: false,
      },
      { platform: "feishu", chatId: "chat" },
    );
    assert.equal(context.recent("feishu:chat", 10)[0]?.text, "hello");
    assert.equal(
      context.recent("feishu:cli_a:group:chat", 10)[0]?.text,
      "hello",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
