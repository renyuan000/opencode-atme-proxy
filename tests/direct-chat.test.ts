import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProxyRuntime } from "../src/core/runtime.js";
import type { LoadedConfig } from "../src/core/config.js";
import type { PlatformAdapter } from "../src/core/ports.js";
import type { ApprovalView, CapabilitySet, IncomingMessage, OutboundMessage, OutboundTarget } from "../src/core/types.js";
import type { OpenCodeBridge } from "../src/core/opencode.js";
import { readGroupStateFile, writeGroupStateFile } from "./group-state.js";

function config(stateDir: string, enabled = true, onlyOwner = true): LoadedConfig {
  return {
    path: join(stateDir, "config.json"),
    secrets: { appSecret: "s", filterApiKey: "k" },
    config: {
      version: 1,
      app: { stateDir, logLevel: "error", logToFile: false },
      platforms: { feishu: { enabled: true, appId: "cli", appSecretEnv: "X", domain: "feishu", botOpenId: "bot", me: { openId: "owner" }, approvers: [], bootstrap: { claimCodeEnv: "C", allowPrivateClaim: false, maxClaimAttemptsPer10Min: 5 }, groups: [], receiveAllGroupMessages: false, rateLimit: { sendPerSecond: 1000, burst: 1000 } } },
      recovery: { enabled: false, onStartup: false, lookbackSeconds: 3600, maxMessages: 100, maxPlainMessagesPerGroup: 20, includeMentions: true, includeRelevantPlain: true, resumeTasks: false, resumeMaxAgeDays: 7, staleRunningMinutes: 30, nudgeHours: 0 },
      polling: { enabled: false, intervalSeconds: 180, pageSize: 50, maxPages: 20, lookbackSeconds: 3600, overlapSeconds: 60 },
      filter: { mode: "external", enabled: false, keywordPrefilter: true, apiKeyEnv: "K", model: "", maxMessagesPerBatch: 50, maxCharsPerMessage: 800, timeoutMs: 1000, minTaskConfidence: 0.7, minReviewConfidence: 0.5, profile: { name: "", role: "", keywords: [], excludeKeywords: [], projects: [], tasks: [] } },
      analysis: { mode: "main_agent", timeoutMs: 1000 },
      botReply: { enabled: false, allowNoReply: true, escalateWhenUnsure: true, analyzeBeforeEscalate: false, minAnswerConfidence: 0.6, decisionMentionText: "需要你确认", maxQuestionChars: 160, perSenderPerMinute: 6, perSenderConcurrent: 1, cooldownSeconds: 0, ownerBypass: true, overloadReply: "稍后", maxMessagesPerSenderPerRun: 20 },
      opencode: { baseUrl: "http://127.0.0.1:19876", passwordEnv: "P", sessionTitlePrefix: "atme", keepSessions: true, sessionListVisible: true },
      subagents: { enabled: false, analyst: "atme-analyst", executor: "atme-executor", reviewer: "atme-reviewer", maxChildrenPerTask: 3, maxChildrenGlobal: 8, depth: 1, archiveAfterDays: 7, deleteAfterDays: 30 },
      directChat: { enabled, onlyOwner },
      context: { enabled: false, maxMessagesPerChat: 20, maxCharsPerMessage: 300, ttlDays: 7, maxChats: 100, includeInAnalysis: false, storeAnalysisSnippets: false, storeMentions: true, storeRelevantScan: true, storeOwnerDm: true, burstWindowSeconds: 15,
        burstWaitMs: 0, burstMaxMessages: 5, burstMaxChars: 4000, burstGrouping: false },
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
  replies: string[] = [];
  sent: string[] = [];
  recalled: string[] = [];
  acknowledged: string[] = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  capabilities(): CapabilitySet {
    return { realtimeMentions: true, allGroupMessages: true, groupHistory: false, directMessage: true, reply: true, interactiveCard: true, buttons: true, threads: false, attachmentsInbound: true, identityVerify: true };
  }
  async healthCheck() { return { ok: true }; }
  async listMessages() { return { messages: [] }; }
  async send(_t: OutboundTarget, message: OutboundMessage) {
    this.sent.push(JSON.stringify(message));
    return { messageId: "s" };
  }
  async reply(_t: { chatId: string; messageId: string }, m: OutboundMessage) {
    this.replies.push(m.kind === "text" ? m.text : "[card]");
    return { messageId: "r" };
  }
  renderApproval(view: ApprovalView): OutboundMessage { return { kind: "text", text: `approval:${view.draft ?? ""}` }; }
  renderReplyManagement(view: any): OutboundMessage {
    return { kind: "card", card: { view } };
  }
  async recallMessage(_chatId: string, messageId: string): Promise<void> {
    this.recalled.push(messageId);
  }
  async fetchResource(_messageId: string, _key: string, kind?: "image" | "file") {
    if (kind === "file") return { data: Buffer.from("任务清单\n1. 完成 A"), mime: "text/plain" };
    return { data: Buffer.from([137, 80, 78, 71]), mime: "image/png" };
  }
  async acknowledge(messageId: string) {
    this.acknowledged.push(messageId);
  }
  async verifyActor() { return true; }
}

class Bridge implements OpenCodeBridge {
  attachments: unknown[] = [];
  lastText = "";
  getClient(): any {
    return { project: { list: async () => ({ data: [] }) }, experimental: { session: { list: async () => ({ data: [] }) } } };
  }
  async createSession() { return "s"; }
  async prompt(_sessionId: string, input: any) {
    this.attachments = input.attachments ?? [];
    this.lastText = input.text ?? "";
    return "私聊回复";
  }
  async deleteSession() {}
}

function dm(id: string, senderId = "owner", text = "帮我看看支付灰度"): IncomingMessage {
  return { platform: "feishu", messageId: id, chat: { id: "p2p", kind: "direct" }, sender: { platform: "feishu", id: senderId }, senderType: "user", text, mentions: [], createdAt: Date.now(), rawType: "text" };
}

test("owner direct message gets a reply", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-dm-"));
  try {
    const adapter = new Adapter();
    const runtime = new ProxyRuntime({ platform: adapter, bridge: new Bridge(), loaded: config(dir) });
    await runtime.start();
    await runtime.ingest(dm("m1"));
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(adapter.replies, ["私聊回复"]);
    assert.ok(adapter.acknowledged.includes("m1"));
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("non-owner direct message is ignored", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-dm-"));
  try {
    const adapter = new Adapter();
    const runtime = new ProxyRuntime({ platform: adapter, bridge: new Bridge(), loaded: config(dir) });
    await runtime.start();
    await runtime.ingest(dm("m1", "stranger"));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(adapter.replies.length, 0);
    assert.ok(adapter.sent.some((item) => item.includes("试图私聊机器人")));
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("non-owner direct message is answered when onlyOwner is false", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-dm-"));
  try {
    const adapter = new Adapter();
    const runtime = new ProxyRuntime({ platform: adapter, bridge: new Bridge(), loaded: config(dir, true, false) });
    await runtime.start();
    await runtime.ingest(dm("m1", "stranger"));
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(adapter.replies, ["私聊回复"]);
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("owner can rewrite a pending reply draft", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-dm-"));
  try {
    await writeGroupStateFile(
      dir,
      "chat",
      "pending.json",
      JSON.stringify({
        version: 1,
        cards: {
          "task_x:reply": {
            platform: "feishu",
            taskId: "task_x",
            analysisVersion: 1,
            planHash: "old",
            actorId: "owner",
            mode: "reply",
            chatId: "chat",
            sourceMessageId: "m0",
            style: "concise",
            draft: "旧草稿",
            createdAt: Date.now(),
          },
        },
      }),
    );
    const adapter = new Adapter();
    const runtime = new ProxyRuntime({ platform: adapter, bridge: new Bridge(), loaded: config(dir) });
    await runtime.start();
    await runtime.ingest(dm("m1", "owner", "/改写 新草稿"));
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(adapter.sent.some((text) => text.includes("新草稿")));
    const pending = JSON.parse(await readGroupStateFile(dir, "pending.json")) as {
      cards: Record<string, { draft: string }>;
    };
    assert.equal(pending.cards["task_x:reply"]?.draft, "新草稿");
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("owner can cancel a pending reply draft", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-dm-"));
  try {
    await writeGroupStateFile(
      dir,
      "chat",
      "pending.json",
      JSON.stringify({
        version: 1,
        cards: {
          "task_x:reply": {
            platform: "feishu",
            taskId: "task_x",
            analysisVersion: 1,
            planHash: "old",
            actorId: "owner",
            mode: "reply",
            chatId: "chat",
            sourceMessageId: "m0",
            style: "concise",
            draft: "旧草稿",
            createdAt: Date.now(),
          },
        },
      }),
    );
    const adapter = new Adapter();
    const runtime = new ProxyRuntime({ platform: adapter, bridge: new Bridge(), loaded: config(dir) });
    await runtime.start();
    await runtime.ingest(dm("m1", "owner", "/取消"));
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(adapter.replies.some((text) => text.includes("已取消")));
    const pending = JSON.parse(await readGroupStateFile(dir, "pending.json")) as {
      cards: Record<string, unknown>;
    };
    assert.equal(Object.keys(pending.cards).length, 0);
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("owner can list and cancel a specific reply draft", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-dm-"));
  try {
    const now = Date.now();
    const card = (taskId: string, draft: string, createdAt: number) => ({
      platform: "feishu",
      taskId,
      analysisVersion: 1,
      planHash: `h-${taskId}`,
      actorId: "owner",
      mode: "reply",
      chatId: "chat",
      sourceMessageId: `m-${taskId}`,
      style: "concise",
      draft,
      createdAt,
    });
    await writeGroupStateFile(
      dir,
      "chat",
      "pending.json",
      JSON.stringify({
        version: 1,
        cards: {
          "task_x:reply": card("task_x", "旧草稿 X", now - 1000),
          "task_y:reply": card("task_y", "旧草稿 Y", now),
        },
      }),
    );
    const adapter = new Adapter();
    const runtime = new ProxyRuntime({ platform: adapter, bridge: new Bridge(), loaded: config(dir) });
    await runtime.start();
    await runtime.ingest(dm("m1", "owner", "/列表"));
    await new Promise((r) => setTimeout(r, 100));
    const listed = adapter.replies.at(-1) ?? "";
    assert.match(listed, /task_x/);
    assert.match(listed, /task_y/);
    await runtime.ingest(dm("m2", "owner", "/取消 2"));
    await new Promise((r) => setTimeout(r, 100));
    assert.match(adapter.replies.at(-1) ?? "", /task_x/);
    const pending = JSON.parse(await readGroupStateFile(dir, "pending.json")) as {
      cards: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(pending.cards), ["task_y:reply"]);
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("direct chat can be disabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-dm-"));
  try {
    const adapter = new Adapter();
    const runtime = new ProxyRuntime({ platform: adapter, bridge: new Bridge(), loaded: config(dir, false) });
    await runtime.start();
    await runtime.ingest(dm("m1"));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(adapter.replies.length, 0);
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("owner can view and recall a sent reply from the card", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-dm-"));
  try {
    const adapter = new Adapter();
    const runtime = new ProxyRuntime({ platform: adapter, bridge: new Bridge(), loaded: config(dir) });
    await runtime.start();
    await runtime.ingest(dm("m1", "owner", "hello"));
    await new Promise((r) => setTimeout(r, 100));
    const stored = JSON.parse(await readGroupStateFile(dir, "sent-replies.json")) as {
      replies: Array<{ id: string; status: string }>;
    };
    assert.equal(stored.replies.length, 1);
    const action = {
      platform: "feishu",
      actionId: "a1",
      taskId: "__manage__",
      action: "reply_manage",
      actor: { platform: "feishu", id: "owner" },
    };
    const listed = await (runtime as any).onAction(action);
    assert.equal(listed.ok, true);
    assert.equal(listed.card, undefined);
    const management = JSON.parse(adapter.sent.at(-1) ?? "{}") as {
      card: { view: { sent: Array<{ text: string }>; pending: unknown[] } };
    };
    assert.equal(management.card.view.sent[0]?.text, "私聊回复");
    assert.equal(management.card.view.pending.length, 0);
    const recall = await (runtime as any).onAction({
      ...action,
      actionId: "a2",
      action: "recall_reply",
      replyId: stored.replies[0]?.id,
    });
    assert.equal(recall.ok, true);
    assert.deepEqual(adapter.recalled, ["r"]);
    const after = JSON.parse(await readGroupStateFile(dir, "sent-replies.json")) as {
      replies: Array<{ status: string }>;
    };
    assert.equal(after.replies[0]?.status, "recalled");
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("direct messages are ignored when owner is not bound", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-dm-"));
  try {
    const loaded = config(dir);
    loaded.config.platforms.feishu.me = {};
    loaded.config.platforms.feishu.approvers = [];
    const adapter = new Adapter();
    const runtime = new ProxyRuntime({ platform: adapter, bridge: new Bridge(), loaded });
    await runtime.start();
    await runtime.ingest(dm("m1", "stranger", "hello"));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(adapter.replies.length, 0);
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("owner image is analyzed ephemerally and not reattached to the persistent reply", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-dm-"));
  try {
    const adapter = new Adapter();
    const bridge = new Bridge();
    const runtime = new ProxyRuntime({ platform: adapter, bridge, loaded: config(dir) });
    await runtime.start();
    await runtime.ingest({
      ...dm("m1", "owner", "[图片]"),
      rawType: "image",
      attachments: [{ kind: "image", key: "img_1" }],
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(bridge.attachments.length, 0);
    assert.match(bridge.lastText, /图片视觉摘要|图片 OCR/);
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("owner file attachment text is passed to the model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-dm-"));
  try {
    const adapter = new Adapter();
    const bridge = new Bridge();
    const runtime = new ProxyRuntime({ platform: adapter, bridge, loaded: config(dir) });
    await runtime.start();
    await runtime.ingest({
      ...dm("m1", "owner", "帮我看这个文件"),
      rawType: "file",
      attachments: [{ kind: "file", key: "file_1", name: "plan.txt" }],
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.match(bridge.lastText, /任务清单/);
    assert.match(bridge.lastText, /完成 A/);
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
