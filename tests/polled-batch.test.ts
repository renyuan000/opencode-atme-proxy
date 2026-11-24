import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProxyRuntime } from "../src/core/runtime.js";
import type { LoadedConfig } from "../src/core/config.js";
import type { PlatformAdapter } from "../src/core/ports.js";
import type {
  CapabilitySet,
  IncomingMessage,
  OutboundMessage,
  OutboundTarget,
  ApprovalView,
} from "../src/core/types.js";
import type { OpenCodeBridge } from "../src/core/opencode.js";

function makeConfig(stateDir: string, filterEnabled = true): LoadedConfig {
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
        enabled: true,
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
        enabled: filterEnabled,
        keywordPrefilter: true,
        baseUrl: "http://localhost",
        apiKeyEnv: "ATME_FILTER_API_KEY",
        model: "test",
        maxMessagesPerBatch: 50,
        maxCharsPerMessage: 800,
        timeoutMs: 1000,
        minTaskConfidence: 0.7,
        minReviewConfidence: 0.5,
        profile: {
          name: "",
          role: "",
          keywords: ["支付"],
          excludeKeywords: [],
          projects: [],
          tasks: [],
        },
      },
      analysis: { mode: "main_agent", timeoutMs: 1000 },
      botReply: {
        enabled: true,
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
        allowExternalModel: true,
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
  sent: Array<{ target: OutboundTarget; message: OutboundMessage }> = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  capabilities(): CapabilitySet {
    return {
      realtimeMentions: true,
      allGroupMessages: false,
      groupHistory: true,
      directMessage: true,
      reply: true,
      interactiveCard: true,
      buttons: true,
      threads: false,
      attachmentsInbound: true,
      identityVerify: true,
    };
  }
  async healthCheck() {
    return { ok: true };
  }
  async listMessages() {
    return { messages: [] };
  }
  async send(target: OutboundTarget, message: OutboundMessage) {
    this.sent.push({ target, message });
    return { messageId: `s-${this.sent.length}` };
  }
  async reply() {
    return { messageId: "r" };
  }
  renderApproval(_view: ApprovalView): OutboundMessage {
    return { kind: "text", text: "approval" };
  }
  async verifyActor() {
    return true;
  }
}

class FakeBridge implements OpenCodeBridge {
  getClient(): any {
    return {
      project: { list: async () => ({ data: [] }) },
      experimental: { session: { list: async () => ({ data: [] }) } },
    };
  }
  async createSession() {
    return "s";
  }
  async prompt() {
    return "ok";
  }
  async deleteSession() {}
}

function msg(id: string, text: string): IncomingMessage {
  return {
    platform: "feishu",
    messageId: id,
    chat: { id: "chat", kind: "group" },
    sender: { platform: "feishu", id: "u1", displayName: "李四" },
    senderType: "user",
    text,
    mentions: [],
    createdAt: Date.now(),
    rawType: "text",
  };
}

test("polled batch only sends one digest for relevant messages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-batch-"));
  try {
    const adapter = new FakeAdapter();
    const runtime = new ProxyRuntime({
      platform: adapter,
      bridge: new FakeBridge(),
      loaded: makeConfig(dir),
    });
    // Inject a fake LLM by monkeypatching relevance via private access.
    const runtimeAny = runtime as any;
    runtimeAny.relevance = {
      classify: async (messages: IncomingMessage[]) => ({
        items: messages.map((message) => ({
          messageId: message.messageId,
          relevant: message.text.includes("支付"),
          actionability: "fyi",
          ownerAttention: true,
          reason: "keyword",
          confidence: 0.8,
          keywordHit: true,
        })),
        stats: {
          messages: messages.length,
          batches: 1,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          durationMs: 0,
          model: "test",
          failures: 0,
          failedMessageIds: [],
        },
      }),
    };
    await runtime.start();
    await runtime.ingestBatch([
      msg("m1", "支付进度"),
      msg("m2", "无关消息"),
      msg("m3", "支付灰度"),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(adapter.sent.length, 1);
    const text = adapter.sent[0]?.message.kind === "text" ? adapter.sent[0].message.text : "";
    assert.match(text, /群消息分析\nchat\n与你相关 2 条，共 3 条/);
    assert.match(text, /支付进度/);
    assert.doesNotMatch(text, /无关消息/);
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
