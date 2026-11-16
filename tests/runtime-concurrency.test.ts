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
  PlatformAction,
  PlatformActionResult,
} from "../src/core/types.js";
import type { OpenCodeBridge } from "../src/core/opencode.js";

function config(stateDir: string): LoadedConfig {
  return {
    path: join(stateDir, "config.json"),
    secrets: { appSecret: "s", filterApiKey: "k" },
    config: {
      version: 1,
      app: { stateDir, logLevel: "error", logToFile: false },
      platforms: {
        feishu: {
          enabled: true,
          appId: "cli_test",
          appSecretEnv: "FEISHU_APP_SECRET",
          domain: "feishu",
          botOpenId: "bot",
          me: { openId: "me" },
      bootstrap: {
        claimCodeEnv: "ATME_CLAIM_CODE",
        allowPrivateClaim: true,
        maxClaimAttemptsPer10Min: 5,
      },

          approvers: [{ openId: "me" }],
          groups: [{ chatId: "chat", enabled: true }],
          receiveAllGroupMessages: false,
          rateLimit: { sendPerSecond: 1000, burst: 1000 },
        },
      },
      polling: {
        enabled: false,
        intervalSeconds: 180,
        pageSize: 50,
        maxPages: 20,
        lookbackSeconds: 3600,
        overlapSeconds: 60,
      },
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
      filter: {
        mode: "external",
        enabled: false,
        keywordPrefilter: true,
        apiKeyEnv: "ATME_FILTER_API_KEY",
        model: "",
        maxMessagesPerBatch: 50,
        maxCharsPerMessage: 800,
        timeoutMs: 1000,
        minTaskConfidence: 0.7,
        minReviewConfidence: 0.5,
        profile: {
          name: "",
          role: "",
          keywords: [],
          excludeKeywords: [],
          projects: [],
          tasks: [],
        },
      },
      analysis: { mode: "main_agent", timeoutMs: 1000 },
      botReply: {
        enabled: false,
        allowNoReply: true,
        escalateWhenUnsure: true,
        analyzeBeforeEscalate: false,
        minAnswerConfidence: 0.6,
        decisionMentionText: "需要你确认",
        maxQuestionChars: 160,
        perSenderPerMinute: 6,
        perSenderConcurrent: 1,
        cooldownSeconds: 0,
        ownerBypass: true,
        overloadReply: "请求有点多，先排队",
        maxMessagesPerSenderPerRun: 20,
      },
      opencode: {
        baseUrl: "http://127.0.0.1:19876",
        passwordEnv: "ATME_OPENCODE_PASSWORD",
        sessionTitlePrefix: "atme",
        keepSessions: true,
        sessionListVisible: true,
      },
      reply: {
        defaultStyle: "concise",
        maxChars: 320,
        detailMaxChars: 2000,
        detailTriggers: ["详细"],
        requireApprovalForMentionMe: true,
        acknowledgeLongTasks: false,
        ackDelayMs: 0,
        ackText: "收到",
      },
      concurrency: {
        global: 8,
        mentionConcurrency: 4,
        scanConcurrency: 1,
        perChat: 1,
        maxQueue: 100,
        mentionTimeoutMs: 5000,
        scanTimeoutMs: 5000,
        analysisTimeoutMs: 5000,
        maxRetries: 0,
        retryDelayMs: 1,
      },
      repos: [],
      policy: {
        defaultDenyGroups: true,
        autoReplyOnMention: false,
        groupWriteBack: false,
        requireMergeApproval: true,
        allowExternalModel: false,
        autoAnalyzeTasks: false,
        maxConcurrentExecutions: 2,
        approvalTimeoutHours: 24,
        executionTimeoutMinutes: 60,
        maxExecutionRetries: 0,
      },
      budget: {
        maxMessagesPerRun: 500,
        maxTokensPerRun: 50000,
        maxExecutionsPerDay: 10,
      },
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
      context: {
        enabled: true,
        maxMessagesPerChat: 20,
        maxCharsPerMessage: 300,
        ttlDays: 7,
        maxChats: 100,
        includeInAnalysis: true,
        storeAnalysisSnippets: false,
        storeMentions: true,
        storeRelevantScan: true,
        storeOwnerDm: true,
        burstWindowSeconds: 15,
      burstWaitMs: 0,
        burstMaxMessages: 5,
        burstMaxChars: 4000,
        burstGrouping: false,
      },
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

class FakeAdapter implements PlatformAdapter {
  readonly platform = "feishu";
  replies: Array<{ messageId: string; text: string }> = [];
  sent: Array<{ target: OutboundTarget; message: OutboundMessage }> = [];
  private handlers?: Parameters<PlatformAdapter["start"]>[0];
  constructor(private readonly delayMs = 0) {}
  capabilities(): CapabilitySet {
    return {
      realtimeMentions: true,
      allGroupMessages: true,
      groupHistory: false,
      directMessage: true,
      reply: true,
      interactiveCard: true,
      buttons: true,
      threads: false,
      attachmentsInbound: true,
      identityVerify: true,
    };
  }
  async start(handlers: Parameters<PlatformAdapter["start"]>[0]): Promise<void> {
    this.handlers = handlers;
  }
  async stop(): Promise<void> {
    this.handlers = undefined;
  }
  async healthCheck() {
    return { ok: true };
  }
  async listMessages() {
    return { messages: [] };
  }
  async send(target: OutboundTarget, message: OutboundMessage) {
    this.sent.push({ target, message });
    return { messageId: `sent-${this.sent.length}` };
  }
  async reply(target: { chatId: string; messageId: string }, message: OutboundMessage) {
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const text = message.kind === "text" ? message.text : "[card]";
    this.replies.push({ messageId: target.messageId, text });
    return { messageId: `r-${this.replies.length}` };
  }
  renderApproval(_view: ApprovalView): OutboundMessage {
    return { kind: "text", text: "approval" };
  }
  async verifyActor() {
    return true;
  }
  async handleAction(action: PlatformAction): Promise<PlatformActionResult> {
    return this.handlers!.onAction(action);
  }
}

class FakeBridge implements OpenCodeBridge {
  getClient(): any {
    return {
      project: { list: async () => ({ data: [] }) },
      experimental: { session: { list: async () => ({ data: [] }) } },
    };
  }
  active = 0;
  peak = 0;
  prompts = 0;
  async createSession(): Promise<string> {
    return `s-${++this.prompts}`;
  }
  async prompt(): Promise<string> {
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    await new Promise((resolve) => setTimeout(resolve, 30));
    this.active--;
    return "ok";
  }
  async deleteSession(): Promise<void> {}
}

function mention(id: string, text: string, senderId = "u1"): IncomingMessage {
  return {
    platform: "feishu",
    messageId: id,
    chat: { id: "chat", kind: "group" },
    sender: { platform: "feishu", id: senderId, displayName: senderId },
    senderType: "user",
    text,
    mentions: [{ platform: "feishu", id: "bot" }],
    createdAt: Date.now(),
    rawType: "text",
  };
}

test("concurrent bot mentions in one chat are processed concurrently", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-runtime-"));
  try {
    const adapter = new FakeAdapter(40);
    const bridge = new FakeBridge();
    const runtime = new ProxyRuntime({
      platform: adapter,
      bridge,
      loaded: config(dir),
    });
    await runtime.start();
    const started = Date.now();
    await Promise.all([
      runtime.ingest(mention("m1", "问题1", "u1")),
      runtime.ingest(mention("m2", "问题2", "u2")),
      runtime.ingest(mention("m3", "问题3", "u3")),
      runtime.ingest(mention("m4", "问题4", "u4")),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const elapsed = Date.now() - started;
    assert.equal(adapter.replies.length, 4);
    assert.ok(bridge.peak >= 2, `expected parallel prompts, peak=${bridge.peak}`);
    assert.ok(elapsed < 1000, `expected concurrent handling, elapsed=${elapsed}`);
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("duplicate message is processed once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-runtime-"));
  try {
    const adapter = new FakeAdapter();
    const bridge = new FakeBridge();
    const runtime = new ProxyRuntime({ platform: adapter, bridge, loaded: config(dir) });
    await runtime.start();
    await runtime.ingest(mention("m1", "问题"));
    await runtime.ingest(mention("m1", "问题"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(adapter.replies.length, 1);
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bot self messages are ignored", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-runtime-"));
  try {
    const adapter = new FakeAdapter();
    const bridge = new FakeBridge();
    const runtime = new ProxyRuntime({ platform: adapter, bridge, loaded: config(dir) });
    await runtime.start();
    const self = mention("m1", "self");
    self.senderType = "bot";
    await runtime.ingest(self);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(adapter.replies.length, 0);
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
