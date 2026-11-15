import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProxyRuntime } from "../src/core/runtime.js";
import type { LoadedConfig } from "../src/core/config.js";
import type { PlatformAdapter } from "../src/core/ports.js";
import type { ApprovalView, CapabilitySet, IncomingMessage, OutboundMessage, OutboundTarget } from "../src/core/types.js";
import type { OpenCodeBridge } from "../src/core/opencode.js";

function config(stateDir: string, storeRelevantScan = true): LoadedConfig {
  return {
    path: join(stateDir, "config.json"),
    secrets: { appSecret: "s", filterApiKey: "k" },
    config: {
      version: 1,
      app: { stateDir, logLevel: "error" },
      platforms: { feishu: { enabled: true, appId: "cli", appSecretEnv: "X", domain: "feishu", botOpenId: "bot", me: { openId: "owner" }, approvers: [], bootstrap: { claimCodeEnv: "C", allowPrivateClaim: false, maxClaimAttemptsPer10Min: 5 }, groups: [{ chatId: "chat", enabled: true }], receiveAllGroupMessages: false, rateLimit: { sendPerSecond: 1000, burst: 1000 } } },
      recovery: { enabled: false, onStartup: false, lookbackSeconds: 3600, maxMessages: 100, maxPlainMessagesPerGroup: 20, includeMentions: true, includeRelevantPlain: true, resumeTasks: false, resumeMaxAgeDays: 7, staleRunningMinutes: 30, nudgeHours: 0 },
      polling: { enabled: false, intervalSeconds: 180, pageSize: 50, maxPages: 20, lookbackSeconds: 3600, overlapSeconds: 60 },
      filter: { enabled: false, keywordPrefilter: true, apiKeyEnv: "K", model: "", maxMessagesPerBatch: 50, maxCharsPerMessage: 800, timeoutMs: 1000, minTaskConfidence: 0.7, minReviewConfidence: 0.5, profile: { name: "", role: "", keywords: [], excludeKeywords: [], projects: [], tasks: [] } },
      analysis: { mode: "main_agent", timeoutMs: 1000 },
      botReply: { enabled: false, allowNoReply: true, escalateWhenUnsure: true, analyzeBeforeEscalate: false, minAnswerConfidence: 0.6, decisionMentionText: "需要你确认", maxQuestionChars: 160, perSenderPerMinute: 6, perSenderConcurrent: 1, cooldownSeconds: 0, ownerBypass: true, overloadReply: "稍后", maxMessagesPerSenderPerRun: 20 },
      opencode: { baseUrl: "http://127.0.0.1:19876", passwordEnv: "P", sessionTitlePrefix: "atme" },
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
      context: { enabled: true, maxMessagesPerChat: 20, maxCharsPerMessage: 300, ttlDays: 7, maxChats: 100, includeInAnalysis: false, storeAnalysisSnippets: false, storeMentions: true, storeRelevantScan, storeOwnerDm: true },
      memory: { enabled: false, extract: false, maxEntries: 2000, ttlDays: 90, pinnedKinds: ["task", "decision", "deadline"], injectLimit: 8, injectMaxChars: 2000, includeInAnalysis: false, autoExtractFromMentions: false, autoExtractFromAnalysis: false },
      reply: { defaultStyle: "concise", maxChars: 80, detailMaxChars: 300, detailTriggers: ["详细"], requireApprovalForMentionMe: true, acknowledgeLongTasks: false, ackDelayMs: 0, ackText: "收到" },
      concurrency: { global: 8, mentionConcurrency: 4, scanConcurrency: 1, perChat: 1, maxQueue: 100, mentionTimeoutMs: 5000, scanTimeoutMs: 5000, analysisTimeoutMs: 5000, maxRetries: 0, retryDelayMs: 1 },
      repos: [],
      policy: { defaultDenyGroups: true, autoReplyOnMention: false, groupWriteBack: false, requireMergeApproval: true, allowExternalModel: false, autoAnalyzeTasks: false, maxConcurrentExecutions: 2, approvalTimeoutHours: 24, executionTimeoutMinutes: 60, maxExecutionRetries: 0 },
      budget: { maxMessagesPerRun: 500, maxTokensPerRun: 50000, maxExecutionsPerDay: 10 },
      project: { mode: "explicit", worktree: "/repo/demo", allowlist: [], recentSessions: 20, maxAgeDays: 30, cacheSeconds: 60, bindChat: false, includeRecentSessionTitles: 5 },
    },
  } as unknown as LoadedConfig;
}

class Adapter implements PlatformAdapter {
  readonly platform = "feishu";
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  capabilities(): CapabilitySet {
    return { realtimeMentions: true, allGroupMessages: true, groupHistory: false, directMessage: true, reply: true, interactiveCard: true, buttons: true, threads: false, attachmentsInbound: true, identityVerify: true };
  }
  async healthCheck() { return { ok: true }; }
  async listMessages() { return { messages: [] }; }
  async send(_t: OutboundTarget, _m: OutboundMessage) { return { messageId: "s" }; }
  async reply() { return { messageId: "r" }; }
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

function msg(id: string, text: string, mentions: string[] = []): IncomingMessage {
  return { platform: "feishu", messageId: id, chat: { id: "chat", kind: "group" }, sender: { platform: "feishu", id: "u1" }, senderType: "user", text, mentions: mentions.map((m) => ({ platform: "feishu", id: m })), createdAt: Date.now(), rawType: "text" };
}

test("non-mention messages are not stored in chat context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-ctxscope-"));
  try {
    const runtime = new ProxyRuntime({ platform: new Adapter(), bridge: new Bridge(), loaded: config(dir) });
    await runtime.start();
    await runtime.ingest(msg("m1", "午饭吃什么"));
    await new Promise((r) => setTimeout(r, 50));
    await runtime.stop();
    const raw = await readFile(join(dir, "chat-context.json"), "utf8").catch(() => "{\"chats\":{}}");
    const parsed = JSON.parse(raw) as { chats: Record<string, { messages: unknown[] }> };
    const messages = Object.values(parsed.chats).flatMap((chat) => chat.messages);
    assert.equal(messages.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mention messages are stored", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-ctxscope-"));
  try {
    const runtime = new ProxyRuntime({ platform: new Adapter(), bridge: new Bridge(), loaded: config(dir) });
    await runtime.start();
    await runtime.ingest(msg("m1", "支付灰度怎么配", ["bot"]));
    await new Promise((r) => setTimeout(r, 50));
    await runtime.stop();
    const raw = await readFile(join(dir, "chat-context.json"), "utf8");
    const parsed = JSON.parse(raw) as { chats: Record<string, { messages: Array<{ messageId: string; origin?: string }> }> };
    const messages = Object.values(parsed.chats).flatMap((chat) => chat.messages);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.origin, "mention_bot");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
