import assert from "node:assert/strict";
import test from "node:test";
import { RelevanceService, parseClassification, parseJsonLoose } from "../src/core/relevance.js";
import type { LlmClient } from "../src/core/relevance.js";
import type { IncomingMessage } from "../src/core/types.js";

function message(id: string, text: string, mentions: string[] = []): IncomingMessage {
  return {
    platform: "feishu",
    messageId: id,
    chat: { id: "chat", kind: "group" },
    sender: { platform: "feishu", id: "u1", displayName: "李四" },
    senderType: "user",
    text,
    mentions: mentions.map((mention) => ({ platform: "feishu", id: mention })),
    createdAt: Date.now(),
    rawType: "text",
  };
}

function client(output: string): LlmClient {
  return {
    async complete() {
      return {
        text: output,
        model: "test-model",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      };
    },
  };
}

const options = {
  minTaskConfidence: 0.7,
  minReviewConfidence: 0.5,
};

test("parseClassification maps results and drops unknown ids", () => {
  const batch = [message("m1", "支付灰度什么时候上"), message("m2", "无关")];
  const parsed = parseClassification(
    JSON.stringify({
      results: [
        {
          message_id: "m1",
          relevant: true,
          actionability: "task",
          reason: "询问进度",
          confidence: 0.9,
          task: { title: "确认支付灰度时间", project: "订单" },
        },
        {
          message_id: "unknown",
          relevant: true,
          actionability: "task",
          reason: "x",
          confidence: 0.9,
        },
      ],
    }),
    batch,
    options,
  );
  const byId = new Map(parsed.items.map((item) => [item.messageId, item]));
  assert.equal(byId.get("m1")?.relevant, true);
  assert.equal(byId.get("m1")?.task?.title, "确认支付灰度时间");
  assert.equal(byId.get("m2")?.reason, "missing from model output");
  assert.equal(byId.has("unknown"), false);
  assert.deepEqual(parsed.missingIds, ["m2"]);
});

test("validates layer and parses triage metadata", () => {
  const parsed = parseClassification(
    JSON.stringify({
      results: [
        {
          message_id: "m1",
          relevant: true,
          actionability: "task",
          reason: "kafka",
          confidence: 0.9,
          layer: "kafka",
          kafka_role: "producer",
          protocol_family: "http",
        },
        {
          message_id: "m2",
          relevant: true,
          actionability: "fyi",
          reason: "bad layer",
          confidence: 0.9,
          layer: "garbage",
        },
      ],
    }),
    [message("m1", "kafka"), message("m2", "x")],
    options,
  );
  const byId = new Map(parsed.items.map((item) => [item.messageId, item]));
  assert.equal(byId.get("m1")?.layer, "kafka");
  assert.equal(byId.get("m1")?.kafkaRole, "producer");
  assert.equal(byId.get("m1")?.protocolFamily, "http");
  assert.equal(byId.get("m2")?.layer, undefined);
});

test("low confidence tasks are demoted", () => {
  const parsed = parseClassification(
    JSON.stringify({
      results: [
        {
          message_id: "m1",
          relevant: true,
          actionability: "task",
          reason: "maybe",
          confidence: 0.4,
        },
      ],
    }),
    [message("m1", "x")],
    options,
  );
  assert.equal(parsed.items[0]?.relevant, false);
  assert.deepEqual(parsed.missingIds, []);
});

test("parseJsonLoose handles fenced and noisy output", () => {
  assert.deepEqual(parseJsonLoose("```json\n{\"a\":1}\n```"), { a: 1 });
  assert.deepEqual(parseJsonLoose("noise {\"a\":2} tail"), { a: 2 });
});

test("prefilter uses include keywords and exclude keywords", () => {
  const service = new RelevanceService({
    llm: client("{}"),
    profile: { keywords: ["支付"], projects: [], tasks: [] },
    keywords: { include: ["支付"], exclude: ["广告"] },
    keywordPrefilter: true,
    maxMessagesPerBatch: 50,
    maxCharsPerMessage: 800,
    minTaskConfidence: 0.7,
    minReviewConfidence: 0.5,
  });
  assert.equal(service.prefilter(message("m1", "支付回调")).hit, true);
  assert.equal(service.prefilter(message("m2", "支付广告")).hit, false);
  assert.equal(service.prefilter(message("m3", "hello", ["me"])).hit, true);
});

test("classify batches, aggregates usage, and fills missing messages", async () => {
  const service = new RelevanceService({
    llm: client(
      JSON.stringify({
        results: [
          {
            message_id: "m1",
            relevant: true,
            actionability: "question",
            reason: "asks",
            confidence: 0.9,
          },
        ],
      }),
    ),
    profile: { keywords: ["支付"], projects: [], tasks: [] },
    keywords: { include: ["支付"], exclude: [] },
    keywordPrefilter: true,
    maxMessagesPerBatch: 2,
    maxCharsPerMessage: 800,
    minTaskConfidence: 0.7,
    minReviewConfidence: 0.5,
  });
  const { items, stats } = await service.classify([
    message("m1", "支付怎么配"),
    message("m2", "支付灰度"),
    message("m3", "无关"),
  ]);
  assert.equal(items.length, 3);
  assert.equal(stats.batches, 2);
  assert.equal(stats.totalTokens, 30);
  const byId = new Map(items.map((item) => [item.messageId, item]));
  assert.equal(byId.get("m1")?.actionability, "question");
  assert.equal(byId.get("m2")?.reason, "missing from model output");
  assert.equal(byId.get("m3")?.reason, "missing from model output");
});

test("empty keyword profile still sends plain messages to classification", () => {
  const service = new RelevanceService({
    llm: client("{}"),
    profile: { keywords: [], projects: [], tasks: [] },
    keywords: { include: [], exclude: [] },
    keywordPrefilter: true,
    maxMessagesPerBatch: 50,
    maxCharsPerMessage: 800,
    minTaskConfidence: 0.7,
    minReviewConfidence: 0.5,
  });
  assert.equal(service.prefilter(message("m1", "普通工作讨论")).hit, true);
});
