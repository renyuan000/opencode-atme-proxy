import assert from "node:assert/strict";
import test from "node:test";
import { buildStyleInstruction, detectReplyDepth, detectReplyStyle, enforceReplyLength } from "../src/adapters/feishu/reply-style.js";
import type { IncomingMessage } from "../src/core/types.js";

const options = {
  defaultStyle: "concise" as const,
  maxChars: 20,
  detailMaxChars: 100,
  detailTriggers: ["详细", "展开"],
};

function message(text: string): IncomingMessage {
  return {
    platform: "feishu",
    messageId: "m1",
    chat: { id: "c", kind: "group" },
    sender: { platform: "feishu", id: "u" },
    senderType: "user",
    text,
    mentions: [],
    createdAt: Date.now(),
    rawType: "text",
  };
}

test("concise by default, detailed on trigger", () => {
  assert.equal(detectReplyStyle(message("进度如何"), options), "concise");
  assert.equal(detectReplyStyle(message("请详细说明"), options), "detailed");
  assert.equal(detectReplyStyle(message("请展开"), options), "detailed");
});

test("length limits follow style", () => {
  const long = "a".repeat(200);
  assert.equal(enforceReplyLength(long, "concise", options).length, 21);
  assert.equal(enforceReplyLength(long, "detailed", options).length, 101);
});

test("style instructions differ", () => {
  assert.match(buildStyleInstruction("concise", options), /极简/);
  assert.match(buildStyleInstruction("detailed", options), /详细/);
});

test("detects simple acknowledgements", () => {
  assert.equal(detectReplyDepth(message("可以，30 秒够用。"), options), "ack");
  assert.equal(detectReplyDepth(message("收到"), options), "ack");
  assert.equal(detectReplyDepth(message("30 秒够用吗？"), options), "answer");
  assert.equal(detectReplyDepth(message("请详细说明"), options), "detail");
});
