import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProxyRuntime } from "../src/core/runtime.js";
import type { LoadedConfig } from "../src/core/config.js";
import type { PlatformAdapter } from "../src/core/ports.js";
import type { ApprovalView, CapabilitySet, IncomingMessage, OutboundMessage, OutboundTarget } from "../src/core/types.js";
import type { OpenCodeBridge } from "../src/core/opencode.js";

function config(stateDir: string): LoadedConfig {
  return {
    path: join(stateDir, "config.json"),
    secrets: { appSecret: "s", filterApiKey: "k" },
    config: {
      version: 1,
      app: { stateDir, logLevel: "error", logToFile: false },
      platforms: { feishu: { enabled: true, appId: "cli", appSecretEnv: "X", domain: "feishu", botOpenId: "bot", me: { openId: "owner" }, approvers: [], bootstrap: { claimCodeEnv: "C", allowPrivateClaim: false, maxClaimAttemptsPer10Min: 5 }, groups: [{ chatId: "oc_1", enabled: true }], receiveAllGroupMessages: true, rateLimit: { sendPerSecond: 1000, burst: 1000 } } },
      recovery: { enabled: false, onStartup: false, lookbackSeconds: 3600, maxMessages: 10, maxPlainMessagesPerGroup: 5, includeMentions: false, includeRelevantPlain: false, resumeTasks: false, resumeMaxAgeDays: 7, staleRunningMinutes: 30, nudgeHours: 0 },
      polling: { enabled: false, intervalSeconds: 180, pageSize: 50, maxPages: 20, lookbackSeconds: 3600, overlapSeconds: 60 },
      filter: { mode: "external", enabled: false, keywordPrefilter: true, apiKeyEnv: "K", model: "", maxMessagesPerBatch: 50, maxCharsPerMessage: 800, timeoutMs: 1000, minTaskConfidence: 0.7, minReviewConfidence: 0.5, profile: { name: "", role: "", keywords: [], excludeKeywords: [], projects: [], tasks: [] } },
      analysis: { mode: "main_agent", timeoutMs: 1000 },
      botReply: { enabled: false, allowNoReply: true, escalateWhenUnsure: true, analyzeBeforeEscalate: false, minAnswerConfidence: 0.6, decisionMentionText: "x", maxQuestionChars: 160, perSenderPerMinute: 60, perSenderConcurrent: 1, cooldownSeconds: 0, ownerBypass: true, overloadReply: "x", maxMessagesPerSenderPerRun: 20 },
      opencode: { baseUrl: "http://127.0.0.1:1", passwordEnv: "P", sessionTitlePrefix: "atme", keepSessions: true, sessionListVisible: true },
      subagents: { enabled: false, analyst: "a", executor: "e", reviewer: "r", maxChildrenPerTask: 3, maxChildrenGlobal: 8, depth: 1, archiveAfterDays: 7, deleteAfterDays: 30 },
      directChat: { enabled: false, onlyOwner: true },
      context: { enabled: false, maxMessagesPerChat: 20, maxCharsPerMessage: 300, ttlDays: 7, maxChats: 100, includeInAnalysis: false, storeAnalysisSnippets: false, storeMentions: false, storeRelevantScan: false, storeOwnerDm: false, burstWindowSeconds: 15,
        burstWaitMs: 0, burstMaxMessages: 5, burstMaxChars: 4000, burstGrouping: false },
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
  sent: string[] = [];
  capabilities(): CapabilitySet {
    return { realtimeMentions: true, allGroupMessages: true, groupHistory: true, directMessage: true, reply: true, interactiveCard: true, buttons: true, threads: false, attachmentsInbound: true, identityVerify: true };
  }
  async start() {}
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
  getClient(): any { return { project: { list: async () => ({ data: [] }) }, experimental: { session: { list: async () => ({ data: [] }) } } }; }
  async createSession() { return "s"; }
  async prompt() { return "ok"; }
  async deleteSession() {}
}

function msg(id: string, text: string): IncomingMessage {
  return { platform: "feishu", messageId: id, chat: { id: "oc_1", kind: "group" }, sender: { platform: "feishu", id: "u1", displayName: "领导" }, senderType: "user", text, mentions: [], createdAt: Date.now(), rawType: "text" };
}

test("filter disabled forwards a raw digest instead of dropping messages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-nofilter-"));
  try {
    const adapter = new Adapter();
    const runtime = new ProxyRuntime({ platform: adapter, bridge: new Bridge(), loaded: config(dir) });
    await runtime.start();
    await runtime.ingestBatch([msg("m1", "流分接下来做的事情：资产台账拆表"), msg("m2", "合并代码已更新前后端服务")]);
    await new Promise((r) => setTimeout(r, 150));
    const digest = adapter.sent.find((text) => text.includes("群消息分析"));
    assert.ok(digest, "expected a digest message");
    assert.match(digest!, /流分接下来做的事情/);
    assert.match(digest!, /合并代码/);
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
