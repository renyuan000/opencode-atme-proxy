import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProxyRuntime } from "../src/core/runtime.js";
import { TaskStore } from "../src/core/task-store.js";
import type { LoadedConfig } from "../src/core/config.js";
import type { PlatformAdapter } from "../src/core/ports.js";
import type {
  ApprovalView,
  CapabilitySet,
  IncomingMessage,
  OutboundMessage,
  OutboundTarget,
  TaskRecord,
} from "../src/core/types.js";
import type { OpenCodeBridge } from "../src/core/opencode.js";

function config(stateDir: string, resume = true): LoadedConfig {
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
      recovery: {
        enabled: true,
        onStartup: false,
        lookbackSeconds: 3600,
        maxMessages: 100,
        maxPlainMessagesPerGroup: 20,
        includeMentions: true,
        includeRelevantPlain: true,
        resumeTasks: resume,
        resumeMaxAgeDays: 7,
        staleRunningMinutes: 1,
        nudgeHours: 0,
      },
      polling: { enabled: false, intervalSeconds: 180, pageSize: 50, maxPages: 20, lookbackSeconds: 3600, overlapSeconds: 60 },
      filter: { enabled: false, keywordPrefilter: true, apiKeyEnv: "K", model: "", maxMessagesPerBatch: 50, maxCharsPerMessage: 800, timeoutMs: 1000, minTaskConfidence: 0.7, minReviewConfidence: 0.5, profile: { name: "", role: "", keywords: [], excludeKeywords: [], projects: [], tasks: [] } },
      analysis: { mode: "main_agent", timeoutMs: 1000 },
      botReply: { enabled: false, allowNoReply: true, escalateWhenUnsure: true, analyzeBeforeEscalate: false, minAnswerConfidence: 0.6, decisionMentionText: "需要你确认", maxQuestionChars: 160, perSenderPerMinute: 6, perSenderConcurrent: 1, cooldownSeconds: 0, ownerBypass: true, overloadReply: "稍后", maxMessagesPerSenderPerRun: 20 },
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
  sent: string[] = [];
  messages: IncomingMessage[] = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  capabilities(): CapabilitySet {
    return { realtimeMentions: true, allGroupMessages: true, groupHistory: true, directMessage: true, reply: true, interactiveCard: true, buttons: true, threads: false, attachmentsInbound: true, identityVerify: true };
  }
  async healthCheck() { return { ok: true }; }
  async listMessages() { return { messages: this.messages }; }
  async send(_t: OutboundTarget, m: OutboundMessage) {
    this.sent.push(m.kind === "text" ? m.text : "[card]");
    return { messageId: "s" };
  }
  async reply() { return { messageId: "r" }; }
  renderApproval(_v: ApprovalView): OutboundMessage { return { kind: "text", text: "approval" }; }
  async verifyActor() { return true; }
}

class Bridge implements OpenCodeBridge {
  getClient(): any {
    return { project: { list: async () => ({ data: [] }) }, experimental: { session: { list: async () => ({ data: [] }) } } };
  }
  async createSession() { return "s"; }
  async prompt() { return "analysis"; }
  async deleteSession() {}
}

function task(state: TaskRecord["state"], updatedAt = Date.now()): TaskRecord {
  return {
    id: "task_open",
    platform: "feishu",
    chatId: "chat",
    messageIds: ["m1"],
    source: "mention_me",
    requester: { platform: "feishu", id: "u1" },
    title: "补支付灰度文档",
    excerpt: "补支付灰度文档",
    keywords: [],
    relevance: { reason: "test", confidence: 1 },
    dedupKey: "dedup_open",
    state,
    createdAt: updatedAt,
    updatedAt,
  };
}

test("resume re-analyzes candidate tasks and nudges stale approvals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-recovery-"));
  try {
    const store = new TaskStore(dir);
    await store.load();
    await store.save(task("candidate"));
    await store.save({
      ...task("awaiting_approval", Date.now() - 2 * 3600_000),
      id: "task_wait",
      dedupKey: "dedup_wait",
    });
    await store.close();
    const adapter = new Adapter();
    const runtime = new ProxyRuntime({ platform: adapter, bridge: new Bridge(), loaded: config(dir) });
    await runtime.start();
    await runtime.recoverOnStartup();
    await new Promise((r) => setTimeout(r, 150));
    const reloaded = new TaskStore(dir);
    await reloaded.load();
    const open = await reloaded.get("task_open");
    const wait = await reloaded.get("task_wait");
    assert.ok(open);
    assert.ok(wait);
    assert.notEqual(open?.state, "candidate");
    assert.ok(wait?.lastNudgeAt);
    assert.ok(adapter.sent.some((text) => text.includes("未完成任务提醒")));
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resume pauses stale executing tasks instead of replaying", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-recovery-"));
  try {
    const store = new TaskStore(dir);
    await store.load();
    await store.save(task("executing", Date.now() - 10 * 60_000));
    await store.close();
    const adapter = new Adapter();
    const runtime = new ProxyRuntime({ platform: adapter, bridge: new Bridge(), loaded: config(dir) });
    await runtime.start();
    await runtime.recoverOnStartup();
    await new Promise((r) => setTimeout(r, 100));
    const reloaded = new TaskStore(dir);
    await reloaded.load();
    const executing = await reloaded.get("task_open");
    assert.equal(executing?.state, "awaiting_approval");
    assert.ok(adapter.sent.some((text) => text.includes("执行被中断")));
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recovery pull skips already processed messages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-recovery-"));
  try {
    const adapter = new Adapter();
    adapter.messages = [
      {
        platform: "feishu",
        messageId: "old",
        chat: { id: "chat", kind: "group" },
        sender: { platform: "feishu", id: "u1" },
        senderType: "user",
        text: "@机器人 支付灰度怎么配",
        mentions: [{ platform: "feishu", id: "bot" }],
        createdAt: Date.now(),
        rawType: "text",
      },
    ];
    const cfg = config(dir);
    cfg.config.recovery.onStartup = true;
    const runtime = new ProxyRuntime({ platform: adapter, bridge: new Bridge(), loaded: cfg });
    await runtime.start();
    await (runtime as any).markProcessed(adapter.messages[0]);
    const before = adapter.sent.length;
    await runtime.recoverOnStartup();
    assert.equal(adapter.sent.length, before);
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
