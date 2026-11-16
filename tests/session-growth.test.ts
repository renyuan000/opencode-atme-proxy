import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProxyRuntime } from "../src/core/runtime.js";
import { OpenCodeLlmClient } from "../src/core/opencode-llm.js";
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
      filter: { mode: "opencode", enabled: true, keywordPrefilter: true, apiKeyEnv: "K", model: "", maxMessagesPerBatch: 50, maxCharsPerMessage: 800, timeoutMs: 1000, minTaskConfidence: 0.7, minReviewConfidence: 0.5, profile: { name: "", role: "", keywords: [], excludeKeywords: [], projects: [], tasks: [] } },
      analysis: { mode: "main_agent", timeoutMs: 1000 },
      botReply: { enabled: false, allowNoReply: true, escalateWhenUnsure: true, analyzeBeforeEscalate: false, minAnswerConfidence: 0.6, decisionMentionText: "x", maxQuestionChars: 160, perSenderPerMinute: 60, perSenderConcurrent: 1, cooldownSeconds: 0, ownerBypass: true, overloadReply: "x", maxMessagesPerSenderPerRun: 20 },
      opencode: { baseUrl: "http://127.0.0.1:1", passwordEnv: "P", sessionTitlePrefix: "atme", keepSessions: true, sessionListVisible: true },
      subagents: { enabled: true, analyst: "a", executor: "e", reviewer: "r", maxChildrenPerTask: 3, maxChildrenGlobal: 8, depth: 1, archiveAfterDays: 7, deleteAfterDays: 30 },
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

class Bridge implements OpenCodeBridge {
  created: string[] = [];
  deleted: string[] = [];
  archived: string[] = [];
  getClient(): any {
    return { project: { list: async () => ({ data: [] }) }, experimental: { session: { list: async () => ({ data: [] }) } } };
  }
  async createSession(input: { title: string }) {
    const id = `ses_${this.created.length + 1}`;
    this.created.push(input.title);
    return id;
  }
  async prompt() { return "{}"; }
  async deleteSession(id: string) { this.deleted.push(id); }
  async archiveSession(id: string) { this.archived.push(id); }
  async getSession() { return { id: "x", title: "x", directory: "/tmp/x" }; }
}

function adapter(): PlatformAdapter {
  return {
    platform: "feishu",
    capabilities: () => ({ realtimeMentions: true, allGroupMessages: true, groupHistory: false, directMessage: true, reply: true, interactiveCard: true, buttons: true, threads: false, attachmentsInbound: true, identityVerify: true }),
    start: async () => {},
    stop: async () => {},
    healthCheck: async () => ({ ok: true }),
    listMessages: async () => ({ messages: [] }),
    send: async () => ({ messageId: "s" }),
    reply: async () => ({ messageId: "r" }),
    renderApproval: (_v: ApprovalView): OutboundMessage => ({ kind: "text", text: "a" }),
    verifyActor: async () => true,
  };
}

test("filter client deletes its session every time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-growth-"));
  try {
    const bridge = new Bridge();
    const client = new OpenCodeLlmClient({
      bridge,
      directory: "/tmp/x",
      titlePrefix: "atme",
    });
    await client.complete([{ role: "user", content: "x" }]);
    await client.complete([{ role: "user", content: "y" }]);
    assert.equal(bridge.created.length, 2);
    assert.equal(bridge.deleted.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("coordinator is reused and children are capped per task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-growth-"));
  try {
    const bridge = new Bridge();
    const runtime = new ProxyRuntime({ platform: adapter(), bridge, loaded: config(dir) });
    const anyRuntime = runtime as unknown as {
      createChildSession(input: Record<string, unknown>): Promise<{ sessionId: string; release: () => void }>;
    };
    const a = await anyRuntime.createChildSession({ platform: "feishu", chatId: "oc_1", directory: "/tmp/x", title: "r1", role: "reply", taskId: "t1" });
    const b = await anyRuntime.createChildSession({ platform: "feishu", chatId: "oc_1", directory: "/tmp/x", title: "r2", role: "reply", taskId: "t1" });
    const c = await anyRuntime.createChildSession({ platform: "feishu", chatId: "oc_1", directory: "/tmp/x", title: "r3", role: "reply", taskId: "t1" });
    await assert.rejects(
      anyRuntime.createChildSession({ platform: "feishu", chatId: "oc_1", directory: "/tmp/x", title: "r4", role: "reply", taskId: "t1" }),
      /max 3/,
    );
    const coordinators = bridge.created.filter((title) => title === "atme:chat:oc_1");
    assert.equal(coordinators.length, 1);
    a.release();
    b.release();
    c.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
