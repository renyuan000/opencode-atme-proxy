import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLogger } from "../src/core/logger.js";
import { SentReplyStore } from "../src/core/sent-reply-store.js";

const logger = createLogger({ scope: "sent-reply-test", level: "error" });

test("sent reply store starts empty when the file is corrupt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-sent-"));
  try {
    const file = join(dir, "sent-replies.json");
    await writeFile(file, "{broken", "utf8");
    const store = new SentReplyStore(file, 24 * 3600_000, 50, logger);
    await store.load();
    assert.deepEqual(store.list(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("only unexpired, unrecalled replies are recallable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-sent-"));
  try {
    const now = Date.now();
    const file = join(dir, "sent-replies.json");
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        replies: [
          {
            id: "old",
            platform: "feishu",
            chatId: "chat",
            senderLabel: "A",
            sourceMessageId: "m1",
            sentMessageId: "om_old",
            text: "old",
            sourceText: "src",
            sentAt: now - 25 * 3600_000,
            status: "sent",
          },
          {
            id: "recalled",
            platform: "feishu",
            chatId: "chat",
            senderLabel: "A",
            sourceMessageId: "m2",
            sentMessageId: "om_recalled",
            text: "recalled",
            sourceText: "src",
            sentAt: now,
            status: "recalled",
          },
          {
            id: "fresh",
            platform: "feishu",
            chatId: "chat",
            senderLabel: "A",
            sourceMessageId: "m3",
            sentMessageId: "om_fresh",
            text: "fresh",
            sourceText: "src",
            sentAt: now,
            status: "sent",
          },
        ],
      }),
      "utf8",
    );
    const store = new SentReplyStore(file, 7 * 24 * 3600_000, 50, logger);
    await store.load();
    assert.deepEqual(
      store.listRecallable(5).map((item) => item.id),
      ["fresh"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
