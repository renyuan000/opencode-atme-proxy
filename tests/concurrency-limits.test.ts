import assert from "node:assert/strict";
import test from "node:test";
import { ProxyRuntime } from "../src/core/runtime.js";
import type { LoadedConfig } from "../src/core/config.js";

function config(maxPerTask: number, maxGlobal: number): LoadedConfig {
  return {
    path: "/tmp/x",
    secrets: { appSecret: "s", filterApiKey: "k" },
    config: {
      version: 1,
      app: { stateDir: "/tmp/x", logLevel: "error" },
      platforms: { feishu: { enabled: true, appId: "cli", appSecretEnv: "X", domain: "feishu", botOpenId: "bot", me: { openId: "owner" }, approvers: [], bootstrap: { claimCodeEnv: "C", allowPrivateClaim: false, maxClaimAttemptsPer10Min: 5 }, groups: [], receiveAllGroupMessages: false, rateLimit: { sendPerSecond: 1000, burst: 1000 } } },
      recovery: { enabled: false, onStartup: false, lookbackSeconds: 3600, maxMessages: 10, maxPlainMessagesPerGroup: 5, includeMentions: true, includeRelevantPlain: false, resumeTasks: false, resumeMaxAgeDays: 7, staleRunningMinutes: 30, nudgeHours: 0 },
      polling: { enabled: false, intervalSeconds: 180, pageSize: 50, maxPages: 20, lookbackSeconds: 3600, overlapSeconds: 60 },
      filter: { mode: "external", enabled: false, keywordPrefilter: true, apiKeyEnv: "K", model: "", maxMessagesPerBatch: 50, maxCharsPerMessage: 800, timeoutMs: 1000, minTaskConfidence: 0.7, minReviewConfidence: 0.5, profile: { name: "", role: "", keywords: [], excludeKeywords: [], projects: [], tasks: [] } },
      analysis: { mode: "main_agent", timeoutMs: 1000 },
      botReply: { enabled: false, allowNoReply: true, escalateWhenUnsure: true, analyzeBeforeEscalate: false, minAnswerConfidence: 0.6, decisionMentionText: "x", maxQuestionChars: 160, perSenderPerMinute: 6, perSenderConcurrent: 1, cooldownSeconds: 0, ownerBypass: true, overloadReply: "x", maxMessagesPerSenderPerRun: 20 },
      opencode: { baseUrl: "http://127.0.0.1:1", passwordEnv: "P", sessionTitlePrefix: "atme", keepSessions: true, sessionListVisible: true },
      subagents: { enabled: true, analyst: "a", executor: "e", reviewer: "r", maxChildrenPerTask: maxPerTask, maxChildrenGlobal: maxGlobal, depth: 1, archiveAfterDays: 7, deleteAfterDays: 30 },
      directChat: { enabled: false, onlyOwner: true },
      context: { enabled: false, maxMessagesPerChat: 20, maxCharsPerMessage: 300, ttlDays: 7, maxChats: 100, includeInAnalysis: false, storeAnalysisSnippets: false, storeMentions: true, storeRelevantScan: false, storeOwnerDm: false },
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

test("per-task child limit is enforced and released", async () => {
  const opened: string[] = [];
  const runtime = new ProxyRuntime({
    platform: {
      platform: "feishu",
      capabilities: () => ({ realtimeMentions: true, allGroupMessages: true, groupHistory: false, directMessage: true, reply: true, interactiveCard: true, buttons: true, threads: false, attachmentsInbound: true, identityVerify: true }),
      start: async () => {},
      stop: async () => {},
      healthCheck: async () => ({ ok: true }),
      listMessages: async () => ({ messages: [] }),
      send: async () => ({ messageId: "s" }),
      reply: async () => ({ messageId: "r" }),
      renderApproval: () => ({ kind: "text", text: "a" }),
      verifyActor: async () => true,
    },
    bridge: {
      getClient: () => ({}) as never,
      createSession: async (input: { title: string }) => {
        opened.push(input.title);
        return `ses_${opened.length}`;
      },
      prompt: async () => "ok",
      deleteSession: async () => {},
    } as never,
    loaded: config(2, 8),
  });
  const anyRuntime = runtime as unknown as {
    createChildSession(input: Record<string, unknown>): Promise<{ sessionId: string; release: () => void }>;
  };
  const first = await anyRuntime.createChildSession({ platform: "feishu", chatId: "c", directory: "/tmp/x", title: "c1", role: "reply", taskId: "t1" });
  const second = await anyRuntime.createChildSession({ platform: "feishu", chatId: "c", directory: "/tmp/x", title: "c2", role: "reply", taskId: "t1" });
  await assert.rejects(
    anyRuntime.createChildSession({ platform: "feishu", chatId: "c", directory: "/tmp/x", title: "c3", role: "reply", taskId: "t1" }),
    /max 2/,
  );
  first.release();
  const third = await anyRuntime.createChildSession({ platform: "feishu", chatId: "c", directory: "/tmp/x", title: "c3", role: "reply", taskId: "t1" });
  second.release();
  third.release();
});
