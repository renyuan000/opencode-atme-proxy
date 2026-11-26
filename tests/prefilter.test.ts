import assert from "node:assert/strict";
import test from "node:test";
import { prefilterMessage } from "../src/core/prefilter.js";
import type { IncomingMessage } from "../src/core/types.js";

function message(id: string, text: string, mentions: string[] = []): IncomingMessage {
  return {
    platform: "feishu",
    messageId: id,
    chat: { id: "chat", kind: "group" },
    sender: { platform: "feishu", id: "u1" },
    senderType: "user",
    text,
    mentions: mentions.map((mention) => ({ platform: "feishu", id: mention })),
    createdAt: Date.now(),
    rawType: "text",
  };
}

const context = {
  ownerId: "owner",
  botId: "bot",
  ownerKeywords: ["npb-engine", "npb-transform", "流分", "平台资产同步"],
  coreProjects: ["/mnt/d/Work/source/suricata/npb-engine.git"],
  ownerDirection: "负责 npb-engine 采集与 npb-transform 流分",
};

test("@ 别人的平台页面消息判为强外部候选", () => {
  const result = prefilterMessage(
    message("m1", "资产台账添加好了，能发布吗？", ["other"]),
    context,
  );
  assert.equal(result.addressedToOther, true);
  assert.equal(result.strongExternal, true);
  assert.ok(result.score < 0);
  assert.ok(result.layerHints.includes("web_ui"));
});

test("Kafka flow/adapter 消息不会因为 flow 泛词变核心", () => {
  const result = prefilterMessage(
    message("m-flow", "流量、告警通过 npb-network-flow 到达 Adapter 后上报平台", ["owner"]),
    context,
  );
  assert.equal(result.strongExternal, true);
});

test("@ 别人的 adapter/平台消息是强外部", () => {
  const result = prefilterMessage(
    message("m-adapter", "这个 IP 已经发送到平台了，adapter 服务发送成功，流分侧 Kafka 正常，平台未入库", ["owner"]),
    context,
  );
  assert.equal(result.strongExternal, true);
  assert.ok(result.externalHits.includes("adapter"));
});

test("核心项目 + 平台消息仍然不判强外部", () => {
  const result = prefilterMessage(
    message("m-core", "平台资产台账没有显示 npb-transform 上报的资产"),
    context,
  );
  assert.equal(result.strongExternal, false);
});

test("核心引擎压测消息仍然加权", () => {
  const result = prefilterMessage(
    message("m2", "npb-engine 压测 CPU 和吞吐，看下性能", ["other"]),
    context,
  );
  assert.equal(result.performanceHit, true);
  assert.equal(result.strongExternal, false);
  assert.ok(result.coreHits.length > 0);
  assert.ok(result.score > 0);
});

test("Kafka 写入链路和协议解析保留为核心信号", () => {
  const kafka = prefilterMessage(
    message("m3", "npb-transform 写 kafka trend topic 有 lag"),
    context,
  );
  assert.equal(kafka.kafkaHit, true);
  assert.equal(kafka.strongExternal, false);

  const protocol = prefilterMessage(
    message("m4", "npb-engine 识别 HTTP 应用层协议有问题"),
    context,
  );
  assert.ok(protocol.protocolHits.length > 0);
  assert.equal(protocol.strongExternal, false);
  assert.ok(protocol.layerHints.includes("protocol"));
});

test("外部 owner keyword 不会把平台消息升级为核心", () => {
  const result = prefilterMessage(
    message("m6", "平台资产同步任务失败，资产台账没更新", ["other"]),
    context,
  );
  assert.equal(result.coreHits.includes("平台资产同步"), false);
  assert.equal(result.strongExternal, true);
});

test("@ 主人的平台性能指标不会被核心关键词误判", () => {
  const result = prefilterMessage(
    message("m5", "资产台账页面 CPU 0%，能看下吗", ["owner"]),
    context,
  );
  assert.equal(result.mentionedOwner, true);
  assert.equal(result.strongExternal, true);
});
