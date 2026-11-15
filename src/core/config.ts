import { chmod, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createLogger } from "./logger.js";
import { expandHome } from "./util.js";

const GroupSchema = z.object({
  chatId: z.string().min(1),
  name: z.string().optional(),
  enabled: z.boolean().default(true),
});

const FeishuSchema = z.object({
  enabled: z.boolean().default(true),
  appId: z.string().min(1),
  appSecret: z.string().optional(),
  appSecretEnv: z.string().default("FEISHU_APP_SECRET"),
  domain: z.enum(["feishu", "lark"]).default("feishu"),
  botOpenId: z.string().optional(),
  me: z.object({ openId: z.string().min(1) }),
  approvers: z
    .array(z.object({ openId: z.string().min(1), name: z.string().optional() }))
    .min(1),
  groups: z.array(GroupSchema).default([]),
  receiveAllGroupMessages: z.boolean().default(false),
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
});

const ContextSchema = z
  .object({
    enabled: z.boolean().default(true),
    maxMessagesPerChat: z.number().int().min(1).max(200).default(20),
    maxCharsPerMessage: z.number().int().min(20).max(2000).default(300),
    ttlDays: z.number().int().min(1).max(90).default(7),
    maxChats: z.number().int().min(1).max(1000).default(100),
    includeInAnalysis: z.boolean().default(true),
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
});

const ConcurrencySchema = z.object({
  global: z.number().int().min(1).default(8),
  mentionConcurrency: z.number().int().min(1).default(4),
  scanConcurrency: z.number().int().min(1).default(1),
  perChat: z.number().int().min(1).default(1),
  maxQueue: z.number().int().min(1).default(200),
  mentionTimeoutMs: z.number().int().min(1000).default(60_000),
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

export const AppConfigSchema = z.object({
  version: z.number().int().default(1),
  app: z
    .object({
      stateDir: z.string().default("~/.local/state/opencode-atme-proxy"),
      logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
      logFile: z.string().optional(),
    })
    .default({}),
  platforms: z.object({ feishu: FeishuSchema }),
  polling: PollingSchema.default({}),
  filter: FilterSchema.default({}),
  analysis: AnalysisSchema.default({}),
  opencode: OpenCodeSchema.default({}),
  context: ContextSchema,
  project: ProjectSchema,
  reply: ReplySchema.default({}),
  concurrency: ConcurrencySchema.default({}),
  repos: z.array(RepoSchema).default([]),
  policy: PolicySchema.default({}),
  budget: BudgetSchema.default({}),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type FeishuConfig = AppConfig["platforms"]["feishu"];
export type RepoConfig = AppConfig["repos"][number];

export interface Secrets {
  appSecret?: string;
  filterApiKey?: string;
  opencodePassword?: string;
}

export interface LoadedConfig {
  config: AppConfig;
  secrets: Secrets;
  path: string;
}

export interface LoadConfigOptions {
  path?: string;
  env?: NodeJS.ProcessEnv;
  enforcePermissions?: boolean;
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME ?? homedir(), ".config", "opencode-atme-proxy", "config.json");
}

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function applyEnvOverrides(raw: Record<string, any>, env: NodeJS.ProcessEnv): void {
  const feishu = (raw.platforms ??= {}).feishu ??= {};
  const appId = envValue(env, "FEISHU_APP_ID");
  if (appId) feishu.appId = appId;
  const meOpenId = envValue(env, "ATME_ME_OPEN_ID");
  if (meOpenId) feishu.me = { ...(feishu.me ?? {}), openId: meOpenId };
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
  if (filterBaseUrl) filter.baseUrl = filterBaseUrl;
  const filterModel = envValue(env, "ATME_FILTER_MODEL");
  if (filterModel) filter.model = filterModel;

  const opencode = (raw.opencode ??= {});
  const opencodeUrl = envValue(env, "ATME_OPENCODE_URL");
  if (opencodeUrl) opencode.baseUrl = opencodeUrl;

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

async function enforceConfigPermissions(path: string): Promise<void> {
  try {
    const info = await stat(path);
    if ((info.mode & 0o077) !== 0) {
      await chmod(path, 0o600);
      createLogger({ scope: "config" }).warn("config permissions tightened to 600", { path });
    }
  } catch {
    // Permission tightening is best-effort; validation errors are reported elsewhere.
  }
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const env = options.env ?? process.env;
  const path = options.path ?? envValue(env, "ATME_CONFIG") ?? defaultConfigPath(env);
  const rawContent = await readFile(path, "utf8");
  let raw: Record<string, any>;
  try {
    raw = JSON.parse(rawContent) as Record<string, any>;
  } catch (error) {
    throw new Error(`Invalid JSON in config ${path}: ${(error as Error).message}`);
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
  const secrets: Secrets = {
    appSecret:
      envValue(env, config.platforms.feishu.appSecretEnv) ??
      config.platforms.feishu.appSecret ??
      undefined,
    filterApiKey:
      envValue(env, config.filter.apiKeyEnv) ?? config.filter.apiKey ?? undefined,
    opencodePassword:
      envValue(env, config.opencode.passwordEnv) ??
      config.opencode.password ??
      undefined,
  };

  if (config.filter.enabled) {
    if (!config.filter.baseUrl) throw new Error("filter.baseUrl is required when filter is enabled");
    if (!config.filter.model) throw new Error("filter.model is required when filter is enabled");
    if (!secrets.filterApiKey) {
      throw new Error(
        `filter API key is missing: set ${config.filter.apiKeyEnv} or filter.apiKey`,
      );
    }
  }
  if (config.platforms.feishu.enabled && !secrets.appSecret) {
    throw new Error(
      `Feishu app secret is missing: set ${config.platforms.feishu.appSecretEnv} or platforms.feishu.appSecret`,
    );
  }

  if (options.enforcePermissions !== false) {
    await enforceConfigPermissions(path);
  }

  return { config, secrets, path };
}

export function resolveStateDir(config: AppConfig): string {
  return expandHome(config.app.stateDir);
}

export function resolveLogFile(config: AppConfig): string | undefined {
  return config.app.logFile ? expandHome(config.app.logFile) : undefined;
}
