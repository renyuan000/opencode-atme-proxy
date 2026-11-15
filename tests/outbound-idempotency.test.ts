import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProxyRuntime } from "../src/core/runtime.js";
import type { LoadedConfig } from "../src/core/config.js";
import type { PlatformAdapter } from "../src/core/ports.js";
import type {
  ApprovalView,
  CapabilitySet,
  IncomingMessage,
  OutboundMessage,
  OutboundTarget,
} from "../src/core/types.js";
import type { OpenCodeBridge } from "../src/core/opencode.js";

function config(stateDir: string): LoadedConfig {
  return {
    path: join(stateDir, "config.json"),
    secrets: { appSecret: "s", filterApiKey: "k" },
    config: {
      version: 1,
      app: { stateDir, logLevel: "error" },
      platforms: {
        feishu: {
          enabled: true,
          appId: "cli",
          appSecretEnv: "X",
          domain: "feishu",
          botOpenId: "bot",
          me: { openId: "owner" },
          approvers: [],
          bootstrap: { claimCodeEnv: "C", allowPrivateClaim: false, maxClaimAttemptsPer10Min: 5 },
          groups: [{ chatId: "chat", enabled: true }],
          receiveAllGroupMessages: false,
          rateLimit: { sendPerSecond: 1000, burst: 1000 },
        },
      },
      recovery: { enabled: false, onStartup: false, lookbackSeconds: 3600, maxMessages: 100, maxPlainMessagesPerGroup: 20, includeMentions: true, includeRelevantPlain: true, resumeTasks: false, resumeMaxAgeDays: 7, staleRunningMinutes: 30, nudgeHours: 0 },
      polling: { enabled: false, intervalSeconds: 180, pageSize: 50, maxPages: 20, lookbackSeconds: 3600, overlapSeconds: 60 },
      filter: { enabled: false, keywordPrefilter: true, apiKeyEnv: "K", model: "", maxMessagesPerBatch: 50, maxCharsPerMessage: 800, timeoutMs: 1000, minTaskConfidence: 0.7, minReviewConfidence: 0.5, profile: { name: "", role: "", keywords: [], excludeKeywords: [], projects: [], tasks: [] } },
      analysis: { mode: "main_agent", timeoutMs: 1000 },
      botReply: { enabled: false, allowNoReply: true, escalateWhenUnsure: true, analyzeBeforeEscalate: false, minAnswerConfidence: 0.6, decisionMentionText: "需要你确认", maxQuestionChars: 160, perSenderPerMinute: 6, perSenderConcurrent: 1, cooldownSeconds: 0, ownerBypass: true, overloadReply: "稍后", maxMessagesPerSenderPerRun: 20 },
      opencode: { baseUrl: "http://127.0.0.1:19876", passwordEnv: "P", sessionTitlePrefix: "atme" },
      context: { enabled: false, maxMessagesPerChat: 20, maxCharsPerMessage: 300, ttlDays: 7, maxChats: 100, includeInAnalysis: false, storeAnalysisSnippets: false, storeMentions: true, storeRelevantScan: true, storeOwnerDm: true },
      memory: {
        enabled: false,
        extract: false,
        maxEntries: 2000,
        ttlDays: 90,
        pinnedKinds: ["task", "decision", "deadline"],
        injectLimit: 8,
        injectMaxChars: 2000,
        includeInAnalysis: false,
        autoExtractFromMentions: false,
        autoExtractFromAnalysis: false,
      },
      reply: { defaultStyle: "concise", maxChars: 80, detailMaxChars: 300, detailTriggers: ["详细"], requireApprovalForMentionMe: true, acknowledgeLongTasks: false, ackDelayMs: 0, ackText: "收到" },
      concurrency: { global: 8, mentionConcurrency: 4, scanConcurrency: 1, perChat: 1, maxQueue: 100, mentionTimeoutMs: 5000, scanTimeoutMs: 5000, analysisTimeoutMs: 5000, maxRetries: 0, retryDelayMs: 1 },
      repos: [],
      policy: { defaultDenyGroups: true, autoReplyOnMention: false, groupWriteBack: false, requireMergeApproval: true, allowExternalModel: false, autoAnalyzeTasks: false, maxConcurrentExecutions: 2, approvalTimeoutHours: 24, executionTimeoutMinutes: 60, maxExecutionRetries: 0 },
      budget: { maxMessagesPerRun: 500, maxTokensPerRun: 50000, maxExecutionsPerDay: 10 },
      project: { mode: "explicit", worktree: "/repo/demo", allowlist: [], recentSessions: 20, maxAgeDays: 30, cacheSeconds: 60, bindChat: false, includeRecentSessionTitles: 5 },
    },
  } as LoadedConfig;
}

class Adapter implements PlatformAdapter {
  readonly platform = "feishu";
  replies: Array<{ text: string; uuid?: string }> = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  capabilities(): CapabilitySet {
    return { realtimeMentions: true, allGroupMessages: true, groupHistory: false, directMessage: true, reply: true, interactiveCard: true, buttons: true, threads: false, attachmentsInbound: true, identityVerify: true };
  }
  async healthCheck() { return { ok: true }; }
  async listMessages() { return { messages: [] }; }
  async send(_t: OutboundTarget, _m: OutboundMessage) { return { messageId: "s" }; }
  async reply(_t: { chatId: string; messageId: string }, m: OutboundMessage) {
    this.replies.push({ text: m.kind === "text" ? m.text : "[card]", ...(m.uuid ? { uuid: m.uuid } : {}) });
    return { messageId: "r" };
  }
  renderApproval(_v: ApprovalView): OutboundMessage { return { kind: "text", text: "approval" }; }
  async verifyActor() { return true; }
}

class Bridge implements OpenCodeBridge {
  getClient(): any {
    return { project: { list: async () => ({ data: [] }) }, experimental: { session: { list: async () => ({ data: [] }) } } };
  }
  async createSession() { return "s"; }
  async prompt() { return "ok"; }
  async deleteSession() {}
}

function msg(id: string): IncomingMessage {
  return {
    platform: "feishu",
    messageId: id,
    chat: { id: "chat", kind: "group" },
    sender: { platform: "feishu", id: "u1" },
    senderType: "user",
    text: "支付灰度怎么配",
    mentions: [{ platform: "feishu", id: "bot" }],
    createdAt: Date.now(),
    rawType: "text",
  };
}

test("same reply text for same message is sent once with a stable uuid", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-outbound-"));
  try {
    const adapter = new Adapter();
    const runtime = new ProxyRuntime({ platform: adapter, bridge: new Bridge(), loaded: config(dir) });
    await runtime.start();
    await runtime.ingest(msg("m1"));
    await new Promise((r) => setTimeout(r, 100));
    const first = adapter.replies.length;
    assert.equal(first, 1);
    assert.ok(adapter.replies[0]?.uuid);
    await (runtime as any).safeReply(msg("m1"), adapter.replies[0]!.text);
    assert.equal(adapter.replies.length, first);
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
