import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProxyRuntime } from "../src/core/runtime.js";
import type { LoadedConfig } from "../src/core/config.js";
import type { PlatformAdapter } from "../src/core/ports.js";
import type { CapabilitySet, IncomingMessage, OutboundMessage, OutboundTarget, ApprovalView, PlatformAction, PlatformActionResult } from "../src/core/types.js";
import type { OpenCodeBridge } from "../src/core/opencode.js";

function cfg(stateDir: string, autoReply = false, filterEnabled = false): LoadedConfig {
  return {
    path: join(stateDir, "config.json"),
    secrets: { appSecret: "s", filterApiKey: "k" },
    config: {
      version: 1,
      app: { stateDir, logLevel: "error", logToFile: false },
      platforms: { feishu: { enabled: true, appId: "cli", appSecretEnv: "X", domain: "feishu", botOpenId: "bot", me: { openId: "me" }, approvers: [{ openId: "me" }], bootstrap: { claimCodeEnv: "ATME_CLAIM_CODE", allowPrivateClaim: true, maxClaimAttemptsPer10Min: 5 }, groups: [{ chatId: "chat", enabled: true }], receiveAllGroupMessages: false, rateLimit: { sendPerSecond: 1000, burst: 1000 } } },
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
      filter: { mode: "external", enabled: filterEnabled, keywordPrefilter: true, apiKeyEnv: "K", model: "", maxMessagesPerBatch: 50, maxCharsPerMessage: 800, timeoutMs: 1000, minTaskConfidence: 0.7, minReviewConfidence: 0.5, profile: { name: "", role: "", keywords: [], excludeKeywords: [], projects: [], tasks: [] } },
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
      opencode: { baseUrl: "http://127.0.0.1:19876", passwordEnv: "P", sessionTitlePrefix: "atme", keepSessions: true, sessionListVisible: true },
      reply: { defaultStyle: "concise", maxChars: 40, detailMaxChars: 200, detailTriggers: ["详细"], requireApprovalForMentionMe: true, acknowledgeLongTasks: false, ackDelayMs: 0, ackText: "收到" },
      concurrency: { global: 8, mentionConcurrency: 4, scanConcurrency: 1, perChat: 1, maxQueue: 100, mentionTimeoutMs: 5000, scanTimeoutMs: 5000, analysisTimeoutMs: 5000, maxRetries: 0, retryDelayMs: 1 },
      repos: [],
      policy: { defaultDenyGroups: true, autoReplyOnMention: autoReply, groupWriteBack: false, requireMergeApproval: true, allowExternalModel: filterEnabled, autoAnalyzeTasks: false, maxConcurrentExecutions: 2, approvalTimeoutHours: 24, executionTimeoutMinutes: 60, maxExecutionRetries: 0 },
      budget: { maxMessagesPerRun: 500, maxTokensPerRun: 50000, maxExecutionsPerDay: 10 },
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

class Fake implements PlatformAdapter {
  readonly platform = "feishu";
  sent: Array<{ target: OutboundTarget; message: OutboundMessage }> = [];
  replies: string[] = [];
  handlers?: Parameters<PlatformAdapter["start"]>[0];
  async start(h: Parameters<PlatformAdapter["start"]>[0]) { this.handlers = h; }
  async stop() {}
  capabilities(): CapabilitySet { return { realtimeMentions: true, allGroupMessages: true, groupHistory: true, directMessage: true, reply: true, interactiveCard: true, buttons: true, threads: false, attachmentsInbound: true, identityVerify: true }; }
  async healthCheck() { return { ok: true }; }
  async listMessages() { return { messages: [] }; }
  async send(target: OutboundTarget, message: OutboundMessage) { this.sent.push({ target, message }); return { messageId: `s${this.sent.length}` }; }
  async reply(_t: { chatId: string; messageId: string }, message: OutboundMessage) { this.replies.push(message.kind === "text" ? message.text : "[card]"); return { messageId: `r${this.replies.length}` }; }
  renderApproval(view: ApprovalView): OutboundMessage { return { kind: "text", text: `approval:${view.draft ?? ""}` }; }
  async verifyActor(actor: { platform: string; id: string }) { return actor.id === "me"; }
  async act(a: PlatformAction): Promise<PlatformActionResult> { return this.handlers!.onAction(a); }
}

class Bridge implements OpenCodeBridge {
  getClient(): any {
    return {
      project: { list: async () => ({ data: [] }) },
      experimental: { session: { list: async () => ({ data: [] }) } },
    };
  }
  async createSession() { return "s"; }
  prompts = 0;
  texts: string[] = [];
  async prompt(_sessionId?: string, input?: { text?: string }) {
    this.prompts += 1;
    const text = input?.text ?? "";
    this.texts.push(text);
    if (text.includes("群聊记录员")) {
      return JSON.stringify({
        summary: "第 3 步要确定过滤 IP 是否入库",
        decisions: ["入库但标记排除"],
        assumptions: [],
        open_questions: [],
      });
    }
    return "短回复";
  }
  async deleteSession() {}
}

function mention(id: string, text = "支付灰度什么时候上？"): IncomingMessage {
  return { platform: "feishu", messageId: id, chat: { id: "chat", kind: "group" }, sender: { platform: "feishu", id: "u1", displayName: "李四" }, senderType: "user", text, mentions: [{ platform: "feishu", id: "me" }], createdAt: Date.now(), rawType: "text" };
}

test("@me creates approval card, approval replies with label, wrong actor rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-appr-"));
  try {
    const adapter = new Fake();
    const runtime = new ProxyRuntime({ platform: adapter, bridge: new Bridge(), loaded: cfg(dir) });
    await runtime.start();
    await runtime.ingest(mention("m1"));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(adapter.sent.length, 1);
    // find task id via pending file
    const { readFile } = await import("node:fs/promises");
    const pending = JSON.parse(await readFile(join(dir, "pending.json"), "utf8"));
    const key = Object.keys(pending.cards)[0]!;
    const card = pending.cards[key];
    const denied = await adapter.act({ platform: "feishu", actionId: "a1", taskId: card.taskId, action: "approve", actor: { platform: "feishu", id: "stranger" } });
    assert.equal(denied.ok, false);
    assert.equal(adapter.replies.length, 0);
    const ok = await adapter.act({ platform: "feishu", actionId: "a2", taskId: card.taskId, action: "approve", actor: { platform: "feishu", id: "me" } });
    assert.equal(ok.ok, true);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(adapter.replies.length, 1);
    assert.match(adapter.replies[0]!, /助手代答/);
    assert.match(adapter.replies[0]!, /短回复/);
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("simple confirmation gets an ack draft without a model call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-appr-"));
  try {
    const adapter = new Fake();
    const bridge = new Bridge();
    const runtime = new ProxyRuntime({ platform: adapter, bridge, loaded: cfg(dir) });
    await runtime.start();
    await runtime.ingest(mention("m1", "可以，30 秒够用。"));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(adapter.sent.length, 1);
    const sent = adapter.sent[0]?.message;
    assert.equal(sent?.kind, "text");
    if (sent?.kind === "text") assert.match(sent.text, /收到/);
    assert.equal(bridge.prompts, 0);
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("quoted reply includes the referenced message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-appr-"));
  try {
    await writeFile(
      join(dir, "chat-context.json"),
      JSON.stringify({
        version: 1,
        chats: {
          "feishu:chat": {
            platform: "feishu",
            chatId: "chat",
            messages: [
              {
                messageId: "om_owner",
                senderId: "me",
                senderName: "任元",
                text: "@杨丰印 这个你看看：但第 3 步有个语义要定：被过滤掉的 IP 是“不入库”还是“入库但标记排除”？",
                at: Date.now() - 1000,
                mentionMe: false,
                mentionBot: false,
                origin: "owner_group",
              },
            ],
            updatedAt: Date.now(),
          },
        },
      }),
    );
    const adapter = new Fake();
    const bridge = new Bridge();
    const runtime = new ProxyRuntime({ platform: adapter, bridge, loaded: cfg(dir) });
    await runtime.start();
    await runtime.ingest({ ...mention("m1", "哪个？"), replyToMessageId: "om_owner" });
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(bridge.texts.some((text) => text.includes("被回复的消息")));
    assert.ok(bridge.texts.some((text) => text.includes("第 3 步")));
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("group summary is stored and injected into replies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-appr-"));
  try {
    const loaded = cfg(dir);
    (loaded.config as any).groupSession = {
      enabled: true,
      summaryEveryMessages: 1,
      summaryMaxChars: 500,
      timeoutMs: 5000,
    };
    const adapter = new Fake();
    const bridge = new Bridge();
    const runtime = new ProxyRuntime({ platform: adapter, bridge, loaded });
    await runtime.start();
    await runtime.ingest({
      platform: "feishu",
      messageId: "m-owner",
      chat: { id: "chat", kind: "group" },
      sender: { platform: "feishu", id: "me", displayName: "任元" },
      senderType: "user",
      text: "第 3 步：过滤掉的 IP 是不入库还是入库标记排除？",
      mentions: [],
      createdAt: Date.now(),
      rawType: "text",
    });
    await new Promise((r) => setTimeout(r, 150));
    const { readFile } = await import("node:fs/promises");
    const context = JSON.parse(await readFile(join(dir, "group-context.json"), "utf8"));
    assert.match(context.chats["feishu:chat"].summary, /第 3 步/);
    await runtime.ingest(mention("m1", "接下来呢？"));
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(
      bridge.texts.some(
        (text) => text.includes("群摘要（长期") && text.includes("第 3 步"),
      ),
    );
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reply necessity can skip a mention", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-appr-"));
  try {
    const adapter = new Fake();
    const bridge = new Bridge();
    const llm = {
      async complete() {
        return {
          text: JSON.stringify({ reply: false, reason: "通知，无需代答" }),
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          model: "test",
        };
      },
    };
    const runtime = new ProxyRuntime({ platform: adapter, bridge, loaded: cfg(dir), llm });
    await runtime.start();
    await runtime.ingest(mention("m1", "通知：今晚 10 点升级"));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(adapter.sent.length, 0);
    assert.equal(bridge.prompts, 0);
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stale plan hash is rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-appr-"));
  try {
    const adapter = new Fake();
    const runtime = new ProxyRuntime({ platform: adapter, bridge: new Bridge(), loaded: cfg(dir) });
    await runtime.start();
    await runtime.ingest(mention("m1"));
    await new Promise((r) => setTimeout(r, 100));
    const { readFile } = await import("node:fs/promises");
    const pending = JSON.parse(await readFile(join(dir, "pending.json"), "utf8"));
    const card = pending.cards[Object.keys(pending.cards)[0]!];
    const result = await adapter.act({ platform: "feishu", actionId: "a", taskId: card.taskId, planHash: "wrong", action: "approve", actor: { platform: "feishu", id: "me" } });
    assert.equal(result.ok, false);
    assert.match(result.toast ?? "", /计划已变更/);
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("auto reply on mention sends without approval when enabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-appr-"));
  try {
    const adapter = new Fake();
    const runtime = new ProxyRuntime({ platform: adapter, bridge: new Bridge(), loaded: cfg(dir, true, true) });
    (runtime as any).relevance = {
      classify: async (messages: IncomingMessage[]) => ({
        items: messages.map((message) => ({ messageId: message.messageId, relevant: true, actionability: "question", reason: "ask", confidence: 0.9, keywordHit: true })),
        stats: { messages: messages.length, batches: 1, promptTokens: 0, completionTokens: 0, totalTokens: 0, durationMs: 0, model: "t", failures: 0, failedMessageIds: [] },
      }),
    };
    await runtime.start();
    await runtime.ingest(mention("m1"));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(adapter.sent.length, 0);
    assert.equal(adapter.replies.length, 1);
    assert.match(adapter.replies[0]!, /助手代答/);
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
