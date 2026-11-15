import assert from "node:assert/strict";
import test from "node:test";
import { buildBotIntentPrompt, parseBotIntent } from "../src/core/relevance.js";

const input = {
  text: "支付灰度今天能上线吗？",
  history: ["李四: 灰度配置好了"],
  profile: {
    name: "我",
    role: "研发",
    keywords: ["支付"],
    projects: ["支付"],
    tasks: [],
  },
  allowNoReply: true,
};

test("parses need_decision", () => {
  const intent = parseBotIntent(
    JSON.stringify({
      action: "need_decision",
      style: "concise",
      confidence: 0.9,
      reason: "涉及上线承诺",
      question: "今天能否上线？",
    }),
    input,
  );
  assert.equal(intent.action, "need_decision");
  assert.equal(intent.style, "concise");
  assert.equal(intent.question, "今天能否上线？");
});

test("parses no_reply", () => {
  const intent = parseBotIntent(
    JSON.stringify({ action: "no_reply", confidence: 0.8, reason: "寒暄" }),
    input,
  );
  assert.equal(intent.action, "no_reply");
});

test("invalid action falls back to need_decision when allowed", () => {
  const intent = parseBotIntent(
    JSON.stringify({ action: "dance", confidence: 0.7, reason: "?" }),
    input,
  );
  assert.equal(intent.action, "need_decision");
});

test("disallowed no_reply falls back to answer", () => {
  const intent = parseBotIntent(
    JSON.stringify({ action: "no_reply", confidence: 0.9 }),
    { ...input, allowNoReply: false },
  );
  assert.equal(intent.action, "answer");
});

test("clamps confidence and defaults style", () => {
  const intent = parseBotIntent(
    JSON.stringify({ action: "answer", confidence: 2, style: "loud" }),
    input,
  );
  assert.equal(intent.confidence, 1);
  assert.equal(intent.style, "concise");
});

test("prompt contains untrusted-data instruction", () => {
  const messages = buildBotIntentPrompt(input);
  assert.match(messages[0]?.content ?? "", /untrusted_data/);
  assert.equal(messages[1]?.role, "user");
});
