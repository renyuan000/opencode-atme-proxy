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
          me: { openId: "me" },
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
      filter: {
        enabled: false,
        keywordPrefilter: true,
        apiKeyEnv: "K",
        model: "",
        maxMessagesPerBatch: 50,
        maxCharsPerMessage: 800,
        timeoutMs: 1000,
        minTaskConfidence: 0.7,
        minReviewConfidence: 0.5,
        profile: { name: "", role: "", keywords: [], excludeKeywords: [], projects: [], tasks: [] },
      },
      analysis: { mode: "main_agent", timeoutMs: 1000 },
      opencode: { baseUrl: "http://127.0.0.1:19876", passwordEnv: "P", sessionTitlePrefix: "atme" },
      reply: {
        defaultStyle: "concise",
        maxChars: 40,
        detailMaxChars: 200,
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
      budget: { maxMessagesPerRun: 500, maxTokensPerRun: 50000, maxExecutionsPerDay: 10 },
      context: {
        enabled: true,
        maxMessagesPerChat: 20,
        maxCharsPerMessage: 300,
        ttlDays: 7,
        maxChats: 100,
        includeInAnalysis: true,
      },
      project: {
        mode: "explicit",
        worktree: "/repo/demo",
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

class Adapter implements PlatformAdapter {
  readonly platform = "feishu";
  sent: Array<OutboundMessage> = [];
  replies: string[] = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
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
  async healthCheck() {
    return { ok: true };
  }
  async listMessages() {
    return { messages: [] };
  }
  async send(_t: OutboundTarget, m: OutboundMessage) {
    this.sent.push(m);
    return { messageId: "s" };
  }
  async reply(_t: { chatId: string; messageId: string }, m: OutboundMessage) {
    this.replies.push(m.kind === "text" ? m.text : "[card]");
    return { messageId: "r" };
  }
  renderApproval(_v: ApprovalView): OutboundMessage {
    return { kind: "text", text: "approval" };
  }
  async verifyActor() {
    return true;
  }
}

class Bridge implements OpenCodeBridge {
  prompts: string[] = [];
  directories: string[] = [];
  getClient(): any {
    return {
      project: { list: async () => ({ data: [] }) },
      experimental: { session: { list: async () => ({ data: [] }) } },
    };
  }
  async createSession(input: { directory: string }) {
    this.directories.push(input.directory);
    return "s";
  }
  async prompt(_id: string, input: { text: string }) {
    this.prompts.push(input.text);
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
    mentions: [{ platform: "feishu", id: "bot" }],
    createdAt: Date.now(),
    rawType: "text",
  };
}

test("reply uses resolved project directory and recent context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-ctxprompt-"));
  try {
    const bridge = new Bridge();
    const runtime = new ProxyRuntime({ platform: new Adapter(), bridge, loaded: config(dir) });
    await runtime.start();
    await runtime.ingest(msg("m1", "支付灰度什么时候上？"));
    await new Promise((r) => setTimeout(r, 100));
    await runtime.ingest(msg("m2", "刚才那个进度呢？"));
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(bridge.directories.every((d) => d === "/repo/demo"));
    const last = bridge.prompts[bridge.prompts.length - 1] ?? "";
    assert.match(last, /当前项目目录：\/repo\/demo/);
    assert.match(last, /最近群聊上下文/);
    assert.match(last, /支付灰度/);
    await runtime.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
