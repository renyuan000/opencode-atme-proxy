import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProxyRuntime } from "../core/runtime.js";
import type { LoadedConfig } from "../core/config.js";
import type { PlatformAdapter, AdapterHandlers } from "../core/ports.js";
import type {
  ApprovalView,
  CapabilitySet,
  IncomingMessage,
  OutboundMessage,
  OutboundTarget,
  PlatformAction,
  PlatformActionResult,
} from "../core/types.js";
import type { OpenCodeBridge } from "../core/opencode.js";
import type { LlmClient, LlmCompletion } from "../core/relevance.js";
import { createLogger } from "../core/logger.js";

class DemoAdapter implements PlatformAdapter {
  readonly platform = "feishu";
  replies: string[] = [];
  lastMentionedId?: string;
  privateMessages: string[] = [];
  private handlers?: AdapterHandlers;

  capabilities(): CapabilitySet {
    return {
      realtimeMentions: true,
      allGroupMessages: true,
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

  async start(handlers: AdapterHandlers): Promise<void> {
    this.handlers = handlers;
  }

  async stop(): Promise<void> {
    this.handlers = undefined;
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true };
  }

  async listMessages(): Promise<{ messages: IncomingMessage[] }> {
    return { messages: [] };
  }

  async send(target: OutboundTarget, message: OutboundMessage): Promise<{ messageId: string }> {
    const text = message.kind === "text" ? message.text : message.kind === "menu" ? message.text : "[card]";
    if (target.kind === "user") this.privateMessages.push(text);
    return { messageId: `sent_${this.privateMessages.length}` };
  }

  async reply(
    target: { chatId: string; messageId: string },
    message: OutboundMessage,
  ): Promise<{ messageId: string }> {
    void target;
    if (message.kind === "text" && message.mentions?.[0]) {
      this.lastMentionedId = message.mentions[0].id;
    }
    const display =
      message.kind === "text"
        ? `${(message.mentions ?? [])
            .map((mention) => `@${mention.name ?? mention.id}`)
            .join(" ")}${message.mentions?.length ? " " : ""}${message.text}`
        : "[card]";
    this.replies.push(display);
    return { messageId: `reply_${this.replies.length}` };
  }

  renderApproval(view: ApprovalView): OutboundMessage {
    return {
      kind: "text",
      text: `[审批卡] ${view.title}\n拟回复：${view.draft ?? "（无草稿）"}\n计划哈希：${view.planHash}`,
    };
  }

  async verifyActor(actor: { platform: string; id: string }): Promise<boolean> {
    return actor.id === "me";
  }

  async act(action: PlatformAction): Promise<PlatformActionResult> {
    if (!this.handlers) return { ok: false, toast: "not started" };
    return this.handlers.onAction(action);
  }
}

class DemoBridge implements OpenCodeBridge {
  async createSession(): Promise<string> {
    return `session_${Date.now()}`;
  }

  async prompt(_sessionId: string, input: { text: string }): Promise<string> {
    const question = input.text.match(/问题：([\s\S]*)$/)?.[1] ?? input.text;
    if (question.includes("详细")) {
      return "支付灰度分三步：1. 在配置中心新增灰度开关；2. 按租户/百分比放量；3. 监控回调成功率并准备回滚。详细步骤和回滚脚本我可以在批准后整理到任务里。";
    }
    return "灰度开关在配置中心，今天可以先放 5%，观察 30 分钟回调成功率。";
  }

  async deleteSession(): Promise<void> {}

  getClient(): any {
    return {
      project: { list: async () => ({ data: [] }) },
      experimental: { session: { list: async () => ({ data: [] }) } },
    };
  }
}

class DemoLlm implements LlmClient {
  async complete(messages: { role: string; content: string }[]): Promise<LlmCompletion> {
    const payload = messages.find((message) => message.role === "user")?.content ?? "{}";
    const parsed = JSON.parse(payload) as {
      message?: string;
      messages?: Array<{ message_id: string; text: string }>;
    };
    if (typeof parsed.message === "string") {
      const text = parsed.message;
      const needsDecision = /上线|排期|承诺|发布|灰度多少|资源|预算/.test(text);
      const noReply = /^(谢谢|收到|好的|测试一下)[！!。.]?$/.test(text.trim());
      return {
        text: JSON.stringify({
          action: noReply ? "no_reply" : needsDecision ? "need_decision" : "answer",
          kind: noReply
            ? "chat"
            : /文档|任务|做一下|补一下/.test(text)
              ? "task"
              : /提醒|别忘了|截止/.test(text)
                ? "reminder"
                : /通知|已上线|已完成/.test(text)
                  ? "notification"
                  : "question",
          style: text.includes("详细") ? "detailed" : "concise",
          confidence: noReply ? 0.9 : needsDecision ? 0.8 : 0.85,
          reason: noReply
            ? "寒暄/确认，无需助手介入"
            : needsDecision
              ? "涉及上线/排期，需要用户本人决策"
              : "信息明确，可直接回答",
          summary: text.slice(0, 80),
          ...(needsDecision ? { suggested_action: "先评估影响范围，再决定是否承诺" } : {}),
        }),
        model: "demo-model",
        usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 },
      };
    }
    const items = (parsed.messages ?? []).map((message) => {
      const workRelated = /支付|灰度/.test(message.text);
      const needsAction = workRelated && /怎么|什么时候|步骤|文档|需要|默认值/.test(message.text);
      const isNoise = /午饭|天气/.test(message.text);
      const actionability = isNoise ? "noise" : needsAction ? "task" : workRelated ? "fyi" : "noise";
      const relevant = actionability === "task" || actionability === "fyi";
      return {
        message_id: message.message_id,
        relevant,
        actionability,
        reason: relevant ? "涉及支付灰度，属于你的职责" : "与你的工作无关",
        confidence: relevant ? 0.9 : 0.1,
        ...(actionability === "task"
          ? { task: { title: message.text.slice(0, 40), project: "支付" } }
          : {}),
      };
    });
    return {
      text: JSON.stringify({ results: items }),
      model: "demo-model",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };
  }
}

function demoConfig(stateDir: string): LoadedConfig {
  const worktree = join(stateDir, "demo-repo");
  return {
    path: join(stateDir, "config.json"),
    secrets: { appSecret: "demo", filterApiKey: "demo" },
    config: {
      version: 1,
      app: { stateDir, logLevel: "warn" },
      platforms: {
        feishu: {
          enabled: true,
          appId: "cli_demo",
          appSecretEnv: "DEMO",
          domain: "feishu",
          botOpenId: "bot",
          me: { openId: "me" },
      bootstrap: {
        claimCodeEnv: "ATME_CLAIM_CODE",
        allowPrivateClaim: true,
        maxClaimAttemptsPer10Min: 5,
      },

          approvers: [{ openId: "me", name: "我" }],
          groups: [{ chatId: "chat", name: "研发项目群", enabled: true }],
          receiveAllGroupMessages: true,
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
        enabled: true,
        keywordPrefilter: true,
        baseUrl: "http://demo",
        apiKeyEnv: "DEMO",
        model: "demo-model",
        maxMessagesPerBatch: 50,
        maxCharsPerMessage: 800,
        timeoutMs: 5000,
        minTaskConfidence: 0.7,
        minReviewConfidence: 0.5,
        profile: {
          name: "我",
          role: "研发人员",
          keywords: ["支付", "灰度", "文档"],
          excludeKeywords: ["午饭", "天气"],
          projects: ["支付"],
          tasks: [],
        },
      },
      analysis: { mode: "main_agent", timeoutMs: 5000 },
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
        passwordEnv: "DEMO",
        sessionTitlePrefix: "demo",
        keepSessions: true,
        sessionListVisible: true,
      },
      reply: {
        defaultStyle: "concise",
        maxChars: 60,
        detailMaxChars: 400,
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
        mode: "explicit",
        worktree,
        allowlist: [],
        recentSessions: 20,
        maxAgeDays: 30,
        cacheSeconds: 60,
        bindChat: true,
        includeRecentSessionTitles: 5,
      },
      repos: [],
      policy: {
        defaultDenyGroups: true,
        autoReplyOnMention: false,
        groupWriteBack: false,
        requireMergeApproval: true,
        allowExternalModel: true,
        autoAnalyzeTasks: true,
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
    },
  } as LoadedConfig;
}

function message(id: string, text: string, mentions: string[], chatId = "chat"): IncomingMessage {
  return {
    platform: "feishu",
    messageId: id,
    chat: { id: chatId, kind: "group", name: "研发项目群" },
    sender: { platform: "feishu", id: "dev_li", displayName: "李四" },
    senderType: "user",
    text,
    mentions: mentions.map((mention) => ({ platform: "feishu", id: mention })),
    createdAt: Date.now(),
    rawType: "text",
  };
}

function printSection(title: string): void {
  process.stdout.write(`\n=== ${title} ===\n`);
}

async function main(): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), "atme-demo-"));
  const logger = createLogger({ scope: "demo", level: "warn" });
  try {
    await mkdir(join(stateDir, "demo-repo"), { recursive: true });
    await writeFile(join(stateDir, "demo-repo", "README.md"), "demo repo\n");
    const adapter = new DemoAdapter();
    const runtime = new ProxyRuntime({
      platform: adapter,
      bridge: new DemoBridge(),
      loaded: demoConfig(stateDir),
      logger,
      llm: new DemoLlm(),
    });
    await runtime.start();

    printSection("0) 助手角色");
    process.stdout.write("研发任务助手：只处理工作职责相关消息；群内发言标注（助手代答）；默认极简。\n");

    printSection("0.1) owner 绑定（私聊 claim code）");
    const dm: IncomingMessage = {
      ...message("claim-1", "demo-claim", []),
      chat: { id: "p2p", kind: "direct" },
      sender: { platform: "feishu", id: "me", displayName: "我" },
      mentions: [],
    };
    // demo config already has me.openId; a claim DM is recorded but cannot override it.
    await runtime.ingest(dm);
    process.stdout.write("owner 已由配置确定：me（私聊 claim 不会覆盖）\n");

    printSection("1) @机器人：默认极简回复");
    await runtime.ingest(message("m1", "支付回调灰度怎么配？", ["bot"]));
    await new Promise((resolve) => setTimeout(resolve, 200));
    process.stdout.write(`${adapter.replies.at(-1)}\n`);

    printSection("2) @机器人：明确要求详细");
    await runtime.ingest(message("m2", "请详细说明支付灰度步骤", ["bot"]));
    await new Promise((resolve) => setTimeout(resolve, 200));
    process.stdout.write(`${adapter.replies.at(-1)}\n`);

    printSection("3) @机器人：不需要回复（寒暄）");
    await runtime.ingest(message("m3", "谢谢", ["bot"]));
    await new Promise((resolve) => setTimeout(resolve, 200));
    process.stdout.write(`群回复数：${adapter.replies.length}（应为 2，未增加）\n`);

    printSection("4) @机器人：需要你决策 -> 群里 @ 你的主账号");
    await runtime.ingest(message("m4", "支付灰度今天能上线吗？", ["bot"]));
    await new Promise((resolve) => setTimeout(resolve, 200));
    process.stdout.write(`${adapter.replies.at(-1)}\n`);
    process.stdout.write(`@ 的主账号：${adapter.lastMentionedId ?? "none"}\n`);

    printSection("5) 多个同事并发 @机器人：各自处理，互不阻塞");
    await Promise.all([
      runtime.ingest({
        ...message("c1", "支付灰度怎么配？", ["bot"]),
        sender: { platform: "feishu", id: "dev_zhang", displayName: "张三" },
      }),
      runtime.ingest({
        ...message("c2", "支付灰度怎么配？", ["bot"]),
        sender: { platform: "feishu", id: "dev_wang", displayName: "王五" },
      }),
      runtime.ingest({
        ...message("c3", "支付灰度怎么配？", ["bot"]),
        sender: { platform: "feishu", id: "dev_zhao", displayName: "赵六" },
      }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    process.stdout.write(`本轮群回复数：${adapter.replies.length}（应比上一步增加 3）\n`);

    printSection("6) 同一人刷屏：限流并只警告一次");
    const before = adapter.replies.length;
    await Promise.all([
      runtime.ingest({ ...message("s1", "支付灰度怎么配？", ["bot"]), sender: { platform: "feishu", id: "spammer", displayName: "刷屏者" } }),
      runtime.ingest({ ...message("s2", "支付灰度怎么配？", ["bot"]), sender: { platform: "feishu", id: "spammer", displayName: "刷屏者" } }),
      runtime.ingest({ ...message("s3", "支付灰度怎么配？", ["bot"]), sender: { platform: "feishu", id: "spammer", displayName: "刷屏者" } }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    process.stdout.write(`新增回复数：${adapter.replies.length - before}（含 1 条限流提示）\n`);

    printSection("7) @我：生成私聊审批卡（不直接回群）");
    await runtime.ingest(message("m5", "支付灰度什么时候上？", ["me"]));
    await new Promise((resolve) => setTimeout(resolve, 300));
    process.stdout.write(`${adapter.privateMessages.at(-1)}\n`);

    printSection("8) 批准代答：群内出现引用回复 + 助手代答标识");
    const pending = JSON.parse(
      await readFile(join(stateDir, "pending.json"), "utf8"),
    ) as { cards: Record<string, { taskId: string; planHash: string }> };
    const card = Object.values(pending.cards)[0];
    if (!card) throw new Error("no pending approval card");
    const result = await adapter.act({
      platform: "feishu",
      actionId: "demo-approve",
      taskId: card.taskId,
      planHash: card.planHash,
      action: "approve",
      actor: { platform: "feishu", id: "me" },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    process.stdout.write(`操作结果：${result.toast}\n`);
    process.stdout.write(`群内最后一条：${adapter.replies.at(-1)}\n`);

    printSection("9) 非 @ 批量筛选：只私聊汇总，不刷群");
    await runtime.ingestBatch([
      message("m6", "支付灰度昨天已经上线了", []),
      message("m7", "中午吃什么？", []),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    process.stdout.write(`${adapter.privateMessages.at(-1)}\n`);

    printSection("10) 运行指标");
    process.stdout.write(`群回复数：${adapter.replies.length}\n`);
    process.stdout.write(`私聊消息数：${adapter.privateMessages.length}\n`);
    process.stdout.write(`调度器：${JSON.stringify(runtime.stats())}\n`);

    await runtime.stop();
    printSection("演示完成");
    process.stdout.write("没有调用真实飞书、OpenCode 或外部模型；这是纯本地模拟。\n");
    process.stdout.write(`状态目录（已清理）：${stateDir}\n`);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  process.stderr.write(`demo failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
