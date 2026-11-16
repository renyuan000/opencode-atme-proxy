import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProxyRuntime } from "../src/core/runtime.js";
import type { LoadedConfig } from "../src/core/config.js";
import type { AdapterHandlers, PlatformAdapter } from "../src/core/ports.js";
import type { ApprovalView, CapabilitySet, IncomingMessage, OutboundMessage, OutboundTarget } from "../src/core/types.js";
import type { OpenCodeBridge } from "../src/core/opencode.js";

function config(stateDir: string): LoadedConfig {
  return {
    path: join(stateDir, "config.json"),
    secrets: { appSecret: "s", filterApiKey: "k" },
    config: {
      version: 1,
      app: { stateDir, logLevel: "error" },
      platforms: { feishu: { enabled: true, appId: "cli", appSecretEnv: "X", domain: "feishu", botOpenId: "bot", me: { openId: "owner" }, approvers: [], bootstrap: { claimCodeEnv: "C", allowPrivateClaim: false, maxClaimAttemptsPer10Min: 5 }, groups: [], receiveAllGroupMessages: false, rateLimit: { sendPerSecond: 1000, burst: 1000 } } },
      recovery: { enabled: false, onStartup: false, lookbackSeconds: 3600, maxMessages: 10, maxPlainMessagesPerGroup: 5, includeMentions: false, includeRelevantPlain: false, resumeTasks: false, resumeMaxAgeDays: 7, staleRunningMinutes: 30, nudgeHours: 0 },
      polling: { enabled: false, intervalSeconds: 180, pageSize: 50, maxPages: 20, lookbackSeconds: 3600, overlapSeconds: 60 },
      filter: { mode: "external", enabled: false, keywordPrefilter: true, apiKeyEnv: "K", model: "", maxMessagesPerBatch: 50, maxCharsPerMessage: 800, timeoutMs: 1000, minTaskConfidence: 0.7, minReviewConfidence: 0.5, profile: { name: "", role: "", keywords: [], excludeKeywords: [], projects: [], tasks: [] } },
      analysis: { mode: "main_agent", timeoutMs: 1000 },
      botReply: { enabled: false, allowNoReply: true, escalateWhenUnsure: true, analyzeBeforeEscalate: false, minAnswerConfidence: 0.6, decisionMentionText: "x", maxQuestionChars: 160, perSenderPerMinute: 6, perSenderConcurrent: 1, cooldownSeconds: 0, ownerBypass: true, overloadReply: "x", maxMessagesPerSenderPerRun: 20 },
      opencode: { baseUrl: "http://127.0.0.1:1", passwordEnv: "P", sessionTitlePrefix: "atme", keepSessions: true, sessionListVisible: true },
      subagents: { enabled: false, analyst: "a", executor: "e", reviewer: "r", maxChildrenPerTask: 3, maxChildrenGlobal: 8, depth: 1, archiveAfterDays: 7, deleteAfterDays: 30 },
      directChat: { enabled: false, onlyOwner: true },
      context: { enabled: false, maxMessagesPerChat: 20, maxCharsPerMessage: 300, ttlDays: 7, maxChats: 100, includeInAnalysis: false, storeAnalysisSnippets: false, storeMentions: false, storeRelevantScan: false, storeOwnerDm: false },
      memory: { enabled: false, extract: false, maxEntries: 100, ttlDays: 90, pinnedKinds: [], injectLimit: 8, injectMaxChars: 2000, includeInAnalysis: false, autoExtractFromMentions: false, autoExtractFromAnalysis: false },
      reply: { defaultStyle: "concise", maxChars: 80, detailMaxChars: 300, detailTriggers: [], requireApprovalForMentionMe: true, acknowledgeLongTasks: false, ackDelayMs: 0, ackText: "x" },
      concurrency: { global: 8, mentionConcurrency: 4, scanConcurrency: 1, perChat: 1, maxQueue: 100, mentionTimeoutMs: 5000, scanTimeoutMs: 5000, analysisTimeoutMs: 5000, maxRetries: 0, retryDelayMs: 1 },
      repos: [],
      policy: { defaultDenyGroups: true, autoReplyOnMention: false, groupWriteBack: false, requireMergeApproval: true, allowExternalModel: false, autoAnalyzeTasks: false, maxConcurrentExecutions: 2, approvalTimeoutHours: 24, executionTimeoutMinutes: 60, maxExecutionRetries: 0 },
      budget: { maxMessagesPerRun: 500, maxTokensPerRun: 50000, maxExecutionsPerDay: 10 },
      project: { mode: "explicit", worktree: "/tmp/x", allowlist: [], recentSessions: 20, maxAgeDays: 30, cacheSeconds: 60, bindChat: false, includeRecentSessionTitles: 5 },
    },
  } as unknown as LoadedConfig;
}

class Adapter implements PlatformAdapter {
  readonly platform = "feishu";
  handlers?: AdapterHandlers;
  sent: string[] = [];
  capabilities(): CapabilitySet {
    return { realtimeMentions: true, allGroupMessages: true, groupHistory: false, directMessage: true, reply: true, interactiveCard: true, buttons: true, threads: false, attachmentsInbound: true, identityVerify: true };
  }
  async start(h: AdapterHandlers) { this.handlers = h; }
  async stop() {}
  async healthCheck() { return { ok: true }; }
  async listMessages() { return { messages: [] }; }
  async send(_t: OutboundTarget, m: OutboundMessage) {
    this.sent.push(m.kind === "text" ? m.text : "[card]");
    return { messageId: "s" };
  }
  async reply() { return { messageId: "r" }; }
  renderApproval(_v: ApprovalView): OutboundMessage { return { kind: "text", text: "a" }; }
  async verifyActor() { return true; }
}

class Bridge implements OpenCodeBridge {
  getClient(): any {
    return {
      im: { v1: { chat: { get: async () => ({ data: { name: "产品-流分装置" } }) } } },
      project: { list: async () => ({ data: [] }) },
      experimental: { session: { list: async () => ({ data: [] }) } },
    };
  }
  async createSession() { return "s"; }
  async prompt() { return "ok"; }
  async deleteSession() {}
}

function groupMessage(id: string): IncomingMessage {
  return { platform: "feishu", messageId: id, chat: { id: "oc_new", kind: "group" }, sender: { platform: "feishu", id: "u1" }, senderType: "user", text: "你好", mentions: [{ platform: "feishu", id: "bot" }], createdAt: Date.now(), rawType: "text" };
}

test("bot_added auto-allowlists the chat and notifies owner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-member-"));
  try {
    const adapter = new Adapter();
    const runtime = new ProxyRuntime({ platform: adapter, bridge: new Bridge(), loaded: config(dir) });
    await runtime.start();
    await adapter.handlers!.onChatMembership!({
      platform: "feishu",
      chatId: "oc_new",
      change: "bot_added",
      actorId: "owner",
      at: Date.now(),
    });
    assert.ok(adapter.sent.some((text) => text.includes("产品-流分装置")));
    (runtime as any).config.opencode.keepSessions = true;
    await runtime.ingest(groupMessage("m1"));
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(adapter.sent.some((text) => text.includes("产品-流分装置")));
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
