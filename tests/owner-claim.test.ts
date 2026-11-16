import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
    secrets: { appSecret: "s", filterApiKey: "k", claimCode: "123456" },
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
          me: {},
          approvers: [],
          bootstrap: {
            claimCodeEnv: "ATME_CLAIM_CODE",
            allowPrivateClaim: true,
            maxClaimAttemptsPer10Min: 2,
          },
          groups: [{ chatId: "chat", enabled: true }],
          receiveAllGroupMessages: false,
          rateLimit: { sendPerSecond: 1000, burst: 1000 },
        },
      },
      polling: { enabled: false, intervalSeconds: 180, pageSize: 50, maxPages: 20, lookbackSeconds: 3600, overlapSeconds: 60 },
      recovery: {
        enabled: false,
        onStartup: false,
        lookbackSeconds: 21600,
        maxMessages: 200,
        maxPlainMessagesPerGroup: 50,
        includeMentions: true,
        includeRelevantPlain: true,
        resumeTasks: false,
        resumeMaxAgeDays: 7,
        staleRunningMinutes: 30,
        nudgeHours: 24,
      },
      filter: { mode: "external", enabled: false, keywordPrefilter: true, apiKeyEnv: "K", model: "", maxMessagesPerBatch: 50, maxCharsPerMessage: 800, timeoutMs: 1000, minTaskConfidence: 0.7, minReviewConfidence: 0.5, profile: { name: "", role: "", keywords: [], excludeKeywords: [], projects: [], tasks: [] } },
      analysis: { mode: "main_agent", timeoutMs: 1000 },
      botReply: { enabled: true, allowNoReply: true, escalateWhenUnsure: true, analyzeBeforeEscalate: false, minAnswerConfidence: 0.6, decisionMentionText: "需要你确认", maxQuestionChars: 160, perSenderPerMinute: 6, perSenderConcurrent: 1, cooldownSeconds: 0, ownerBypass: true, overloadReply: "请求有点多，先排队", maxMessagesPerSenderPerRun: 20 },
      opencode: { baseUrl: "http://127.0.0.1:19876", passwordEnv: "P", sessionTitlePrefix: "atme", keepSessions: true, sessionListVisible: true },
      subagents: {
        enabled: false,
        analyst: "atme-analyst",
        executor: "atme-executor",
        reviewer: "atme-reviewer",
        maxChildrenPerTask: 3,
        maxChildrenGlobal: 8,
        depth: 1,
        archiveAfterDays: 7,
        deleteAfterDays: 30,
      },
      directChat: { enabled: false, onlyOwner: true },
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
      project: { mode: "explicit", worktree: "/repo/demo", allowlist: [], recentSessions: 20, maxAgeDays: 30, cacheSeconds: 60, bindChat: true, includeRecentSessionTitles: 5 },
    },
  } as LoadedConfig;
}

class Adapter implements PlatformAdapter {
  readonly platform = "feishu";
  sent: Array<{ target: OutboundTarget; message: OutboundMessage }> = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  capabilities(): CapabilitySet {
    return { realtimeMentions: true, allGroupMessages: true, groupHistory: false, directMessage: true, reply: true, interactiveCard: true, buttons: true, threads: false, attachmentsInbound: true, identityVerify: false };
  }
  async healthCheck() { return { ok: true }; }
  async listMessages() { return { messages: [] }; }
  async send(target: OutboundTarget, message: OutboundMessage) { this.sent.push({ target, message }); return { messageId: `s${this.sent.length}` }; }
  async reply() { return { messageId: "r" }; }
  renderApproval(_v: ApprovalView): OutboundMessage { return { kind: "text", text: "approval" }; }
  async verifyActor() { return false; }
}

class Bridge implements OpenCodeBridge {
  getClient(): any {
    return { project: { list: async () => ({ data: [] }) }, experimental: { session: { list: async () => ({ data: [] }) } } };
  }
  async createSession() { return "s"; }
  async prompt() { return "ok"; }
  async deleteSession() {}
}

function dm(id: string, text: string, sender = "ou_owner"): IncomingMessage {
  return {
    platform: "feishu",
    messageId: id,
    chat: { id: "p2p", kind: "direct" },
    sender: { platform: "feishu", id: sender, displayName: "我" },
    senderType: "user",
    text,
    mentions: [],
    createdAt: Date.now(),
    rawType: "text",
  };
}

test("claim code binds owner from DM and persists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-claim-"));
  try {
    const adapter = new Adapter();
    const runtime = new ProxyRuntime({ platform: adapter, bridge: new Bridge(), loaded: config(dir) });
    await runtime.start();
    await runtime.ingest(dm("m1", "123456"));
    const owner = JSON.parse(await readFile(join(dir, "owner.json"), "utf8"));
    assert.equal(owner.owners.feishu.openId, "ou_owner");
    assert.equal(owner.owners.feishu.method, "claim");
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("wrong claim code does not bind and is rate limited", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-claim-"));
  try {
    const adapter = new Adapter();
    const runtime = new ProxyRuntime({ platform: adapter, bridge: new Bridge(), loaded: config(dir) });
    await runtime.start();
    await runtime.ingest(dm("m1", "000000"));
    await runtime.ingest(dm("m2", "000001"));
    await runtime.ingest(dm("m3", "000002"));
    await assert.rejects(readFile(join(dir, "owner.json"), "utf8"), /ENOENT/);
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a second sender cannot override an existing owner via claim", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-claim-"));
  try {
    const adapter = new Adapter();
    const runtime = new ProxyRuntime({ platform: adapter, bridge: new Bridge(), loaded: config(dir) });
    await runtime.start();
    await runtime.ingest(dm("m1", "123456", "ou_owner"));
    await runtime.ingest(dm("m2", "123456", "ou_other"));
    const owner = JSON.parse(await readFile(join(dir, "owner.json"), "utf8"));
    assert.equal(owner.owners.feishu.openId, "ou_owner");
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
