import { chmod, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createLogger } from "./logger.js";
import { expandHome } from "./util.js";
const GroupProjectSchema = z.object({
    primary: z.string().optional(),
    core: z.array(z.string()).default([]),
    reference: z.array(z.string()).default([]),
    secondary: z.array(z.string()).default([]),
});
const GroupSchema = z.object({
    chatId: z.string().min(1),
    name: z.string().optional(),
    enabled: z.boolean().default(true),
    project: GroupProjectSchema.optional(),
});
const FeishuSchema = z.object({
    enabled: z.boolean().default(true),
    appId: z.string().min(1),
    appSecret: z.string().optional(),
    appSecretEnv: z.string().default("FEISHU_APP_SECRET"),
    domain: z.enum(["feishu", "lark"]).default("feishu"),
    botOpenId: z.string().optional(),
    me: z
        .object({
        openId: z.string().optional(),
        name: z.string().optional(),
    })
        .default({}),
    approvers: z
        .array(z.object({ openId: z.string().min(1), name: z.string().optional() }))
        .default([]),
    bootstrap: z
        .object({
        claimCode: z.string().optional(),
        claimCodeEnv: z.string().default("ATME_CLAIM_CODE"),
        allowPrivateClaim: z.boolean().default(true),
        maxClaimAttemptsPer10Min: z.number().int().min(1).max(20).default(5),
    })
        .default({}),
    groups: z.array(GroupSchema).default([]),
    receiveAllGroupMessages: z.boolean().default(false),
    autoSyncGroups: z.boolean().optional(),
    rateLimit: z
        .object({
        sendPerSecond: z.number().positive().default(5),
        burst: z.number().int().positive().default(10),
    })
        .default({}),
});
const ProfileSchema = z.object({
    name: z.string().default(""),
    role: z.string().default(""),
    keywords: z.array(z.string()).default([]),
    excludeKeywords: z.array(z.string()).default([]),
    projects: z.array(z.string()).default([]),
    tasks: z.array(z.string()).default([]),
});
const FilterSchema = z.object({
    enabled: z.boolean().default(true),
    mode: z.enum(["opencode", "external"]).default("opencode"),
    keywordPrefilter: z.boolean().default(true),
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
    apiKeyEnv: z.string().default("ATME_FILTER_API_KEY"),
    model: z.string().default(""),
    maxMessagesPerBatch: z.number().int().min(1).max(100).default(50),
    maxCharsPerMessage: z.number().int().min(50).default(800),
    timeoutMs: z.number().int().min(1000).default(60_000),
    minTaskConfidence: z.number().min(0).max(1).default(0.7),
    minReviewConfidence: z.number().min(0).max(1).default(0.5),
    profile: ProfileSchema.default({}),
});
const RecoverySchema = z
    .object({
    enabled: z.boolean().default(true),
    onStartup: z.boolean().default(true),
    lookbackSeconds: z.number().int().min(60).max(7 * 24 * 3600).default(6 * 3600),
    maxMessages: z.number().int().min(1).max(2000).default(200),
    maxPlainMessagesPerGroup: z.number().int().min(1).max(500).default(50),
    includeMentions: z.boolean().default(true),
    includeRelevantPlain: z.boolean().default(true),
    resumeTasks: z.boolean().default(true),
    resumeMaxAgeDays: z.number().int().min(1).max(365).default(7),
    staleRunningMinutes: z.number().int().min(1).max(1440).default(30),
    nudgeHours: z.number().int().min(0).max(168).default(24),
})
    .default({});
const PollingSchema = z.object({
    enabled: z.boolean().default(true),
    intervalSeconds: z.number().int().min(60).default(180),
    pageSize: z.number().int().min(1).max(50).default(50),
    maxPages: z.number().int().min(1).default(20),
    lookbackSeconds: z.number().int().min(60).default(3600),
    overlapSeconds: z.number().int().min(0).default(60),
});
const AnalysisSchema = z.object({
    mode: z.enum(["main_agent", "cheap_model"]).default("main_agent"),
    model: z
        .object({ providerID: z.string().min(1), modelID: z.string().min(1) })
        .optional(),
    timeoutMs: z.number().int().min(1000).default(180_000),
});
const OpenCodeSchema = z.object({
    baseUrl: z.string().default("http://127.0.0.1:19876"),
    password: z.string().optional(),
    passwordEnv: z.string().default("ATME_OPENCODE_PASSWORD"),
    sessionTitlePrefix: z.string().default("atme"),
    agent: z.string().optional(),
    analysisAgent: z.string().optional(),
    executionAgent: z.string().optional(),
    replyModel: z
        .object({ providerID: z.string().min(1), modelID: z.string().min(1) })
        .optional(),
    keepSessions: z.boolean().default(true),
    sessionListVisible: z.boolean().default(true),
});
const SubagentsSchema = z
    .object({
    enabled: z.boolean().default(true),
    analyst: z.string().default("atme-analyst"),
    executor: z.string().default("atme-executor"),
    reviewer: z.string().default("atme-reviewer"),
    maxChildrenPerTask: z.number().int().min(1).max(10).default(3),
    maxChildrenGlobal: z.number().int().min(1).max(64).default(8),
    depth: z.number().int().min(1).max(3).default(1),
    archiveAfterDays: z.number().int().min(1).max(365).default(7),
    deleteAfterDays: z.number().int().min(1).max(3650).default(30),
})
    .default({});
const DirectChatSchema = z
    .object({
    enabled: z.boolean().default(true),
    onlyOwner: z.boolean().default(true),
    notifyBlocked: z.boolean().optional(),
})
    .default({});
const ContextSchema = z
    .object({
    enabled: z.boolean().default(true),
    maxMessagesPerChat: z.number().int().min(1).max(200).default(50),
    maxCharsPerMessage: z.number().int().min(20).max(2000).default(300),
    ttlDays: z.number().int().min(1).max(90).default(7),
    maxChats: z.number().int().min(1).max(1000).default(100),
    storeAnalysisSnippets: z.boolean().default(false),
    includeInAnalysis: z.boolean().default(true),
    storeMentions: z.boolean().default(true),
    storeRelevantScan: z.boolean().default(true),
    storeMediaPlaceholders: z.boolean().optional(),
    storeAllGroupMessages: z.boolean().optional(),
    storeOwnerDm: z.boolean().default(true),
    storeOwnerGroup: z.boolean().optional(),
    burstWindowSeconds: z.number().int().min(1).max(300).default(5),
    burstWaitMs: z.number().int().min(0).max(10_000).default(5000),
    burstMaxMessages: z.number().int().min(1).max(20).default(5),
    burstMaxChars: z.number().int().min(100).max(20000).default(4000),
    burstGrouping: z.boolean().default(true),
})
    .default({});
const MemorySchema = z
    .object({
    enabled: z.boolean().default(true),
    extract: z.boolean().default(true),
    maxEntries: z.number().int().min(10).max(100_000).default(2000),
    ttlDays: z.number().int().min(1).max(3650).default(90),
    pinnedKinds: z
        .array(z.enum(["task", "decision", "fact", "preference", "deadline", "outcome"]))
        .default(["task", "decision", "deadline"]),
    injectLimit: z.number().int().min(1).max(50).default(8),
    injectMaxChars: z.number().int().min(100).max(8000).default(2000),
    includeInAnalysis: z.boolean().default(true),
    autoExtractFromMentions: z.boolean().default(true),
    autoExtractFromAnalysis: z.boolean().default(true),
})
    .default({});
const EvidenceSchema = z
    .object({
    enabled: z.boolean().default(true),
    retentionDays: z.number().int().min(30).max(3650).default(720),
    maxChars: z.number().int().min(100).max(20000).default(4000),
})
    .default({});
const GroupSessionSchema = z
    .object({
    enabled: z.boolean().default(true),
    summaryEveryMessages: z.number().int().min(1).max(100).default(8),
    summaryMaxChars: z.number().int().min(200).max(8000).default(1500),
    timeoutMs: z.number().int().min(1000).max(120000).default(30_000),
})
    .default({});
const ProjectSchema = z
    .object({
    mode: z.enum(["auto", "explicit"]).default("auto"),
    id: z.string().optional(),
    worktree: z.string().optional(),
    allowlist: z.array(z.string()).default([]),
    fallbackWorktree: z.string().optional(),
    recentSessions: z.number().int().min(1).max(200).default(20),
    maxAgeDays: z.number().int().min(1).max(3650).default(30),
    cacheSeconds: z.number().int().min(1).max(3600).default(60),
    bindChat: z.boolean().default(true),
    includeRecentSessionTitles: z.number().int().min(0).max(20).default(5),
})
    .default({});
const BotReplySchema = z
    .object({
    enabled: z.boolean().default(true),
    allowNoReply: z.boolean().default(true),
    escalateWhenUnsure: z.boolean().default(true),
    analyzeBeforeEscalate: z.boolean().default(true),
    minAnswerConfidence: z.number().min(0).max(1).default(0.6),
    decisionMentionText: z.string().default("需要你确认"),
    maxQuestionChars: z.number().int().min(10).max(500).default(160),
    perSenderPerMinute: z.number().int().min(1).max(60).default(6),
    perSenderConcurrent: z.number().int().min(1).max(10).default(1),
    cooldownSeconds: z.number().int().min(0).max(300).default(5),
    ownerBypass: z.boolean().default(true),
    overloadReply: z.string().default("请求有点多，我先排队处理；紧急事项请直接 @我主人。"),
    maxMessagesPerSenderPerRun: z.number().int().min(1).max(200).default(20),
})
    .default({});
const ReplySchema = z.object({
    defaultStyle: z.enum(["concise", "detailed"]).default("concise"),
    maxChars: z.number().int().min(80).default(320),
    detailMaxChars: z.number().int().min(200).default(2000),
    detailTriggers: z
        .array(z.string())
        .default([
        "详细",
        "展开",
        "完整",
        "具体",
        "细节",
        "为什么",
        "怎么做",
        "怎么弄",
        "步骤",
        "方案",
        "更多",
        "detail",
        "explain",
        "how",
        "why",
        "steps",
        "more",
    ]),
    requireApprovalForMentionMe: z.boolean().default(true),
    acknowledgeLongTasks: z.boolean().default(true),
    ackDelayMs: z.number().int().min(0).default(2000),
    ackText: z.string().default("收到，处理中…"),
    ackReaction: z.string().optional(),
});
const ConcurrencySchema = z.object({
    global: z.number().int().min(1).default(8),
    mentionConcurrency: z.number().int().min(1).default(4),
    scanConcurrency: z.number().int().min(1).default(1),
    perChat: z.number().int().min(1).default(1),
    maxQueue: z.number().int().min(1).default(200),
    mentionTimeoutMs: z.number().int().min(1000).default(120_000),
    scanTimeoutMs: z.number().int().min(1000).default(120_000),
    analysisTimeoutMs: z.number().int().min(1000).default(180_000),
    maxRetries: z.number().int().min(0).default(1),
    retryDelayMs: z.number().int().min(0).default(1000),
});
const RepoSchema = z.object({
    id: z.string().min(1),
    path: z.string().min(1),
    defaultBranch: z.string().default("main"),
    testCommand: z.array(z.array(z.string()).min(1)).default([]),
    lintCommand: z.array(z.array(z.string()).min(1)).default([]),
    allowPush: z.boolean().default(false),
    allowMerge: z.boolean().default(false),
});
const PolicySchema = z.object({
    defaultDenyGroups: z.boolean().default(true),
    autoReplyOnMention: z.boolean().default(false),
    groupWriteBack: z.boolean().default(false),
    requireMergeApproval: z.boolean().default(true),
    allowExternalModel: z.boolean().default(true),
    autoAnalyzeTasks: z.boolean().default(true),
    maxConcurrentExecutions: z.number().int().min(1).default(2),
    approvalTimeoutHours: z.number().int().min(1).default(24),
    executionTimeoutMinutes: z.number().int().min(1).default(60),
    maxExecutionRetries: z.number().int().min(0).default(2),
});
const BudgetSchema = z.object({
    maxMessagesPerRun: z.number().int().min(1).default(500),
    maxTokensPerRun: z.number().int().min(1000).default(50_000),
    maxExecutionsPerDay: z.number().int().min(1).default(10),
});
export const WorkspaceSchema = z
    .object({
    root: z.string().default("/mnt/d/Work/atme-groups"),
})
    .default({});
export const AppConfigSchema = z.object({
    version: z.number().int().default(1),
    app: z
        .object({
        stateDir: z.string().default("~/.local/state/opencode-atme-proxy"),
        logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
        logFile: z.string().optional(),
        logToFile: z.boolean().default(true),
    })
        .default({}),
    workspace: WorkspaceSchema.optional(),
    platforms: z.object({ feishu: FeishuSchema }),
    polling: PollingSchema.default({}),
    recovery: RecoverySchema,
    filter: FilterSchema.default({}),
    analysis: AnalysisSchema.default({}),
    opencode: OpenCodeSchema.default({}),
    subagents: SubagentsSchema,
    directChat: DirectChatSchema,
    context: ContextSchema,
    evidence: EvidenceSchema.optional(),
    groupSession: GroupSessionSchema.optional(),
    memory: MemorySchema,
    project: ProjectSchema,
    botReply: BotReplySchema,
    reply: ReplySchema.default({}),
    concurrency: ConcurrencySchema.default({}),
    repos: z.array(RepoSchema).default([]),
    policy: PolicySchema.default({}),
    budget: BudgetSchema.default({}),
});
export function defaultConfigPath(env = process.env) {
    return join(env.HOME ?? homedir(), ".config", "opencode-atme-proxy", "config.json");
}
function envValue(env, key) {
    const value = env[key];
    return value && value.trim().length > 0 ? value.trim() : undefined;
}
function applyEnvOverrides(raw, env) {
    const feishu = (raw.platforms ??= {}).feishu ??= {};
    const appId = envValue(env, "FEISHU_APP_ID");
    if (appId)
        feishu.appId = appId;
    const meOpenId = envValue(env, "ATME_ME_OPEN_ID");
    if (meOpenId)
        feishu.me = { ...(feishu.me ?? {}), openId: meOpenId };
    const approvers = envValue(env, "ATME_APPROVER_OPEN_IDS");
    if (approvers) {
        feishu.approvers = approvers
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
            .map((openId) => ({ openId }));
    }
    const filter = (raw.filter ??= {});
    const filterBaseUrl = envValue(env, "ATME_FILTER_BASE_URL");
    if (filterBaseUrl)
        filter.baseUrl = filterBaseUrl;
    const filterModel = envValue(env, "ATME_FILTER_MODEL");
    if (filterModel)
        filter.model = filterModel;
    const opencode = (raw.opencode ??= {});
    const opencodeUrl = envValue(env, "ATME_OPENCODE_URL");
    if (opencodeUrl)
        opencode.baseUrl = opencodeUrl;
    const stateDir = envValue(env, "ATME_STATE_DIR");
    if (stateDir) {
        const app = (raw.app ??= {});
        app.stateDir = stateDir;
    }
    const projectWorktree = envValue(env, "ATME_PROJECT_WORKTREE");
    if (projectWorktree) {
        const project = (raw.project ??= {});
        project.mode = "explicit";
        project.worktree = projectWorktree;
    }
    const projectAllowlist = envValue(env, "ATME_PROJECT_ALLOWLIST");
    if (projectAllowlist) {
        const project = (raw.project ??= {});
        project.allowlist = projectAllowlist
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean);
    }
}
async function enforceConfigPermissions(path) {
    try {
        const info = await stat(path);
        if ((info.mode & 0o077) !== 0) {
            await chmod(path, 0o600);
            createLogger({ scope: "config" }).warn("config permissions tightened to 600", { path });
        }
    }
    catch {
        // Permission tightening is best-effort; validation errors are reported elsewhere.
    }
}
export async function loadConfig(options = {}) {
    const env = options.env ?? process.env;
    const path = options.path ?? envValue(env, "ATME_CONFIG") ?? defaultConfigPath(env);
    const rawContent = await readFile(path, "utf8");
    let raw;
    try {
        raw = JSON.parse(rawContent);
    }
    catch (error) {
        throw new Error(`Invalid JSON in config ${path}: ${error.message}`);
    }
    applyEnvOverrides(raw, env);
    const parsed = AppConfigSchema.safeParse(raw);
    if (!parsed.success) {
        const details = parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
            .join("; ");
        throw new Error(`Invalid config ${path}: ${details}`);
    }
    const config = parsed.data;
    if (config.project.mode === "explicit" && !config.project.worktree && !config.project.id) {
        throw new Error("project.mode=explicit requires project.worktree or project.id");
    }
    if (config.project.allowlist.length === 0 && config.repos.length > 0) {
        config.project.allowlist = config.repos.map((repo) => repo.path);
    }
    const secrets = {
        appSecret: envValue(env, config.platforms.feishu.appSecretEnv) ??
            config.platforms.feishu.appSecret ??
            undefined,
        filterApiKey: envValue(env, config.filter.apiKeyEnv) ?? config.filter.apiKey ?? undefined,
        opencodePassword: envValue(env, config.opencode.passwordEnv) ??
            config.opencode.password ??
            undefined,
        claimCode: envValue(env, config.platforms.feishu.bootstrap.claimCodeEnv) ??
            config.platforms.feishu.bootstrap.claimCode ??
            undefined,
    };
    if (config.filter.enabled && config.filter.mode === "external") {
        if (!config.filter.baseUrl)
            throw new Error("filter.baseUrl is required when filter.mode=external");
        if (!config.filter.model)
            throw new Error("filter.model is required when filter.mode=external");
        if (!secrets.filterApiKey) {
            throw new Error(`filter API key is missing: set ${config.filter.apiKeyEnv} or filter.apiKey`);
        }
    }
    if (config.platforms.feishu.enabled && !secrets.appSecret) {
        throw new Error(`Feishu app secret is missing: set ${config.platforms.feishu.appSecretEnv} or platforms.feishu.appSecret`);
    }
    if (config.platforms.feishu.enabled) {
        const feishu = config.platforms.feishu;
        const hasOwner = Boolean(feishu.me.openId) ||
            Boolean(feishu.approvers[0]?.openId) ||
            Boolean(secrets.claimCode);
        if (!hasOwner) {
            throw new Error("owner is not configured: set platforms.feishu.me.openId, platforms.feishu.approvers[0].openId, or platforms.feishu.bootstrap.claimCode (ATME_CLAIM_CODE)");
        }
        if (feishu.me.openId && secrets.claimCode) {
            config.platforms.feishu.bootstrap.allowPrivateClaim = false;
        }
    }
    if (options.enforcePermissions !== false) {
        await enforceConfigPermissions(path);
    }
    return { config, secrets, path };
}
export function resolveStateDir(config) {
    return expandHome(config.app.stateDir);
}
export function resolveLogFile(config) {
    if (config.app.logFile)
        return expandHome(config.app.logFile);
    if (!config.app.logToFile)
        return undefined;
    return expandHome(`${config.app.stateDir}/proxy.log`);
}
//# sourceMappingURL=config.js.map