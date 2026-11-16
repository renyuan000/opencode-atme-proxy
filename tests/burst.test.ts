import assert from "node:assert/strict";
import test from "node:test";
import { selectBurstExtensions } from "../src/core/burst.js";
import type { LlmClient } from "../src/core/relevance.js";
import type { IncomingMessage } from "../src/core/types.js";

function msg(id: string, text: string, at: number): IncomingMessage {
  return {
    platform: "feishu",
    messageId: id,
    chat: { id: "oc_1", kind: "group" },
    sender: { platform: "feishu", id: "u1", displayName: "Cary" },
    senderType: "user",
    text,
    mentions: [],
    createdAt: at,
    rawType: "text",
  };
}

function llm(output: string): LlmClient {
  return {
    async complete() {
      return {
        text: output,
        model: "test",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    },
  };
}

test("selects same-matter followups only", async () => {
  const base = msg("m1", "@任元 我创建了两个表", 1000);
  const followups = [
    msg("m2", "COMMENT ON COLUMN asset_discovery_config.special_filter_enabled", 1013),
    msg("m3", "顺便问下午饭吃什么", 1020),
  ];
  const result = await selectBurstExtensions(
    llm(JSON.stringify({
      results: [
        { message_id: "m2", same_matter: true, reason: "补充同表字段" },
        { message_id: "m3", same_matter: false, reason: "换话题" },
      ],
    })),
    base,
    followups,
  );
  assert.deepEqual(result.selected.map((item) => item.messageId), ["m2"]);
  assert.deepEqual(result.rejected.map((item) => item.messageId), ["m3"]);
  assert.equal(result.usedFallback, false);
});

test("falls back to keeping followups when the model fails", async () => {
  const base = msg("m1", "@任元 表建好了", 1000);
  const followups = [msg("m2", "字段说明如下", 1010)];
  const failing: LlmClient = {
    async complete() {
      throw new Error("boom");
    },
  };
  const result = await selectBurstExtensions(failing, base, followups);
  assert.equal(result.usedFallback, true);
  assert.deepEqual(result.selected.map((item) => item.messageId), ["m2"]);
});
