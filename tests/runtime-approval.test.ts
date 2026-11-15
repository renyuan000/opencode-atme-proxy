import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProxyRuntime } from "../src/core/runtime.js";
import type { LoadedConfig } from "../src/core/config.js";
import type { PlatformAdapter } from "../src/core/ports.js";
import type { CapabilitySet, IncomingMessage, OutboundMessage, OutboundTarget, ApprovalView, PlatformAction, PlatformActionResult } from "../src/core/types.js";
import type { OpenCodeBridge } from "../src/core/opencode.js";

function cfg(stateDir: string, autoReply = false, filterEnabled = false): LoadedConfig {
  return {
    path: join(stateDir, "config.json"),
    secrets: { appSecret: "s", filterApiKey: "k" },
    config: {
      version: 1,
      app: { stateDir, logLevel: "error" },
      platforms: { feishu: { enabled: true, appId: "cli", appSecretEnv: "X", domain: "feishu", botOpenId: "bot", me: { openId: "me" }, approvers: [{ openId: "me" }], groups: [{ chatId: "chat", enabled: true }], receiveAllGroupMessages: false, rateLimit: { sendPerSecond: 1000, burst: 1000 } } },
      polling: { enabled: false, intervalSeconds: 180, pageSize: 50, maxPages: 20, lookbackSeconds: 3600, overlapSeconds: 60 },
      filter: { enabled: filterEnabled, keywordPrefilter: true, apiKeyEnv: "K", model: "", maxMessagesPerBatch: 50, maxCharsPerMessage: 800, timeoutMs: 1000, minTaskConfidence: 0.7, minReviewConfidence: 0.5, profile: { name: "", role: "", keywords: [], excludeKeywords: [], projects: [], tasks: [] } },
      analysis: { mode: "main_agent", timeoutMs: 1000 },
      opencode: { baseUrl: "http://127.0.0.1:19876", passwordEnv: "P", sessionTitlePrefix: "atme" },
      reply: { defaultStyle: "concise", maxChars: 40, detailMaxChars: 200, detailTriggers: ["详细"], requireApprovalForMentionMe: true, acknowledgeLongTasks: false, ackDelayMs: 0, ackText: "收到" },
      concurrency: { global: 8, mentionConcurrency: 4, scanConcurrency: 1, perChat: 1, maxQueue: 100, mentionTimeoutMs: 5000, scanTimeoutMs: 5000, analysisTimeoutMs: 5000, maxRetries: 0, retryDelayMs: 1 },
      repos: [],
      policy: { defaultDenyGroups: true, autoReplyOnMention: autoReply, groupWriteBack: false, requireMergeApproval: true, allowExternalModel: filterEnabled, autoAnalyzeTasks: false, maxConcurrentExecutions: 2, approvalTimeoutHours: 24, executionTimeoutMinutes: 60, maxExecutionRetries: 0 },
      budget: { maxMessagesPerRun: 500, maxTokensPerRun: 50000, maxExecutionsPerDay: 10 },
      context: {
        enabled: true,
        maxMessagesPerChat: 20,
        maxCharsPerMessage: 300,
        ttlDays: 7,
        maxChats: 100,
        includeInAnalysis: true,
      },
      project: {
        mode: "auto",
        allowlist: [],
        recentSessions: 20,
        maxAgeDays: 30,
        cacheSeconds: 60,
        bindChat: true,
        includeRecentSessionTitles: 5,
      },
    },
  } as LoadedConfig;
}

class Fake implements PlatformAdapter {
  readonly platform = "feishu";
  sent: Array<{ target: OutboundTarget; message: OutboundMessage }> = [];
  replies: string[] = [];
  handlers?: Parameters<PlatformAdapter["start"]>[0];
  async start(h: Parameters<PlatformAdapter["start"]>[0]) { this.handlers = h; }
  async stop() {}
  capabilities(): CapabilitySet { return { realtimeMentions: true, allGroupMessages: true, groupHistory: true, directMessage: true, reply: true, interactiveCard: true, buttons: true, threads: false, attachmentsInbound: true, identityVerify: true }; }
  async healthCheck() { return { ok: true }; }
  async listMessages() { return { messages: [] }; }
  async send(target: OutboundTarget, message: OutboundMessage) { this.sent.push({ target, message }); return { messageId: `s${this.sent.length}` }; }
  async reply(_t: { chatId: string; messageId: string }, message: OutboundMessage) { this.replies.push(message.kind === "text" ? message.text : "[card]"); return { messageId: `r${this.replies.length}` }; }
  renderApproval(_v: ApprovalView): OutboundMessage { return { kind: "text", text: "approval" }; }
  async verifyActor(actor: { platform: string; id: string }) { return actor.id === "me"; }
  async act(a: PlatformAction): Promise<PlatformActionResult> { return this.handlers!.onAction(a); }
}

class Bridge implements OpenCodeBridge {
  getClient(): any {
    return {
      project: { list: async () => ({ data: [] }) },
      experimental: { session: { list: async () => ({ data: [] }) } },
    };
  }
  async createSession() { return "s"; }
  async prompt() { return "短回复"; }
  async deleteSession() {}
}

function mention(id: string): IncomingMessage {
  return { platform: "feishu", messageId: id, chat: { id: "chat", kind: "group" }, sender: { platform: "feishu", id: "u1", displayName: "李四" }, senderType: "user", text: "支付灰度什么时候上？", mentions: [{ platform: "feishu", id: "me" }], createdAt: Date.now(), rawType: "text" };
}

test("@me creates approval card, approval replies with label, wrong actor rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-appr-"));
  try {
    const adapter = new Fake();
    const runtime = new ProxyRuntime({ platform: adapter, bridge: new Bridge(), loaded: cfg(dir) });
    await runtime.start();
    await runtime.ingest(mention("m1"));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(adapter.sent.length, 1);
    // find task id via pending file
    const { readFile } = await import("node:fs/promises");
    const pending = JSON.parse(await readFile(join(dir, "pending.json"), "utf8"));
    const key = Object.keys(pending.cards)[0]!;
    const card = pending.cards[key];
    const denied = await adapter.act({ platform: "feishu", actionId: "a1", taskId: card.taskId, action: "approve", actor: { platform: "feishu", id: "stranger" } });
    assert.equal(denied.ok, false);
    assert.equal(adapter.replies.length, 0);
    const ok = await adapter.act({ platform: "feishu", actionId: "a2", taskId: card.taskId, action: "approve", actor: { platform: "feishu", id: "me" } });
    assert.equal(ok.ok, true);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(adapter.replies.length, 1);
    assert.match(adapter.replies[0]!, /助手代答/);
    assert.match(adapter.replies[0]!, /短回复/);
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stale plan hash is rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-appr-"));
  try {
    const adapter = new Fake();
    const runtime = new ProxyRuntime({ platform: adapter, bridge: new Bridge(), loaded: cfg(dir) });
    await runtime.start();
    await runtime.ingest(mention("m1"));
    await new Promise((r) => setTimeout(r, 100));
    const { readFile } = await import("node:fs/promises");
    const pending = JSON.parse(await readFile(join(dir, "pending.json"), "utf8"));
    const card = pending.cards[Object.keys(pending.cards)[0]!];
    const result = await adapter.act({ platform: "feishu", actionId: "a", taskId: card.taskId, planHash: "wrong", action: "approve", actor: { platform: "feishu", id: "me" } });
    assert.equal(result.ok, false);
    assert.match(result.toast ?? "", /计划已变更/);
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("auto reply on mention sends without approval when enabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-appr-"));
  try {
    const adapter = new Fake();
    const runtime = new ProxyRuntime({ platform: adapter, bridge: new Bridge(), loaded: cfg(dir, true, true) });
    (runtime as any).relevance = {
      classify: async (messages: IncomingMessage[]) => ({
        items: messages.map((message) => ({ messageId: message.messageId, relevant: true, actionability: "question", reason: "ask", confidence: 0.9, keywordHit: true })),
        stats: { messages: messages.length, batches: 1, promptTokens: 0, completionTokens: 0, totalTokens: 0, durationMs: 0, model: "t", failures: 0, failedMessageIds: [] },
      }),
    };
    await runtime.start();
    await runtime.ingest(mention("m1"));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(adapter.sent.length, 0);
    assert.equal(adapter.replies.length, 1);
    assert.match(adapter.replies[0]!, /助手代答/);
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
