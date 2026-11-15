# opencode-atme-proxy

A platform-agnostic, approval-gated bot framework that turns chat messages into tasks, analyzes them, and hands approved work to OpenCode.

平台无关、审批门禁的群消息任务机器人框架：从飞书等通信工具采集消息，识别任务，生成分析，经你批准后交给 OpenCode 开发。

> Status: Feishu adapter in progress. Multi-platform ports are in place; WeChat / DingTalk / Slack / Teams / Telegram adapters are planned. Personal WeChat is explicitly out of scope.

---

## 中文

### 它解决什么问题

1. 群消息太多，@我、@机器人、以及与我相关但没 @ 我的消息容易漏。
2. 直接把全量群消息交给主 Agent 太贵，也有提示注入风险。
3. 从“看懂需求”到“真正改代码”之间缺少结构化分析和审批门禁。

### 核心能力

- **实时 @ 接管**：@机器人 直接回答；@我 默认先私聊请示，批准后引用回复。
- **周期筛选**：定时拉取群历史，用关键词 + 低成本模型筛出“我的任务”，只在私聊汇总，不刷群。
- **任务闭环**：任务识别 → 分析 → 审批 → 开发 → 测试 → 回写 → 审计。
- **并发 @**：不同群并行、同一群 @ 消息并发（默认 4）、批量筛选串行，避免互相拖慢。
- **简洁回复**：默认极简；只有对方明确说“详细/展开/步骤/why/how”等才展开。
- **审批门禁**：未批准不改代码；批准绑定计划哈希；自动合并/推送未实现，配置保留。
- **失败不静默**：筛选失败、审批超时、执行失败都会私聊告警并保留状态。

### 项目定位与上下文

机器人在飞书里是“机器人助手”，在 OpenCode 里是“架构师 + 研发负责人”：

- 它需要知道当前主项目在哪个代码目录，而不是在 `/mnt/c/Users/...` 里凭空回答。
- 项目解析优先级：`project.worktree`（显式）→ `project.id` → 最近有会话的 git 项目 → 最近更新的 git 项目 → `repos[0].path` → `fallbackWorktree`。
- 默认会忽略 `global` 项目（worktree 为 `/` 或 home 目录），避免在用户目录下开发。
- 每个飞书群会绑定解析到的项目（`projects.json`），后续同一群的对话与任务使用同一目录。
- 可用 `project.allowlist` 限制只能在哪些仓库下工作，防止越界。
- 解析结果写入日志：`projectId / worktree / reason / score`，便于排查“为什么选了这个项目”。
- 群聊上下文默认保留最近 20 条、7 天，只用于回答与任务分析，不写进群；可在 `context` 中关闭。

### 环境要求

- Node.js ≥ 20.11（已在 24.x 验证），npm ≥ 10
- OpenCode 1.x，且 `opencode serve --port 19876` 已启动
- 飞书自建应用，已开通所需权限与长连接事件
- Git（开发执行需要）
- WSL2 下无需入站端口；机器人只主动连飞书和 localhost OpenCode

### 1. 安装

```bash
git clone https://github.com/renyuan000/opencode-atme-proxy.git
cd opencode-atme-proxy.git
npm ci            # 没有 lockfile 时用 npm install
npm run build     # 插件模式必须构建；独立进程模式也建议构建
```

`node_modules/`、`dist/`、`.env` 已在 `.gitignore` 中，不会提交。

### 2. 配置

```bash
mkdir -p ~/.config/opencode-atme-proxy
cp config.example.json ~/.config/opencode-atme-proxy/config.json
chmod 600 ~/.config/opencode-atme-proxy/config.json
cp .env.example .env
```

填写 `.env`（不要提交）：

```text
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
ATME_ME_OPEN_ID=ou_xxx
ATME_APPROVER_OPEN_IDS=ou_xxx
ATME_FILTER_BASE_URL=https://your-openai-compatible-endpoint/v1
ATME_FILTER_API_KEY=xxx
ATME_FILTER_MODEL=your-low-cost-model
ATME_OPENCODE_URL=http://127.0.0.1:19876
```

`config.json` 必填项：

| 字段 | 说明 |
|------|------|
| `platforms.feishu.appId` | 飞书 App ID（`cli_` 开头） |
| `platforms.feishu.me.openId` | 我的 open_id（`ou_` 开头） |
| `platforms.feishu.approvers[0].openId` | 审批人 open_id，通常是我 |
| `platforms.feishu.groups[].chatId` | 群 chat_id（`oc_` 开头），可多个 |
| `filter.baseUrl/model` | OpenAI 兼容的低成本模型 |
| `opencode.baseUrl` | `http://127.0.0.1:19876` |
| `project.worktree` | 主项目代码目录；不填则自动解析 |
| `repos[]` | 可选；开发执行的仓库白名单、测试/lint 命令 |

飞书后台配置：

1. 事件订阅选择「长连接」，添加 `im.message.receive_v1`、`card.action.trigger`。
2. 权限：`im:message.group_at_msg:readonly`、`im:message.group_msg`（敏感，需管理员审批）、`im:message:send_as_bot`；可选 `contact:user.base:readonly`。
3. 把机器人拉进目标群；群 `chat_id` 可通过事件日志或开放平台接口获取。
4. 以上 scope 名称以飞书开放平台后台实际可选项为准；`im:message.group_msg` 需管理员审批。

项目上下文：

- 最稳的方式是显式配置 `project.worktree` 为目标仓库绝对路径。
- 不配置时自动选择：最近有会话的 git 项目 → 最近更新项目 → `repos[0].path`；会忽略 `global`（`/` 或 home）。
- 建议配置 `project.allowlist`，限制只能在指定仓库下工作。

回复与并发：

- `reply.defaultStyle=concise`，默认 ≤320 字；对方说「详细/展开/步骤/why/how」才展开。
- `concurrency.mentionConcurrency=4`：同一群 @ 消息并发数。
- `concurrency.scanConcurrency=1`：同群批量筛选串行，避免上下文串台。

### 3. 启动

独立守护进程（推荐）：

```bash
npm start
```

后台运行示例：

```bash
nohup npm start >> ~/.local/state/opencode-atme-proxy/daemon.log 2>&1 &
```

开发模式：

```bash
npm run dev
```

OpenCode 插件模式：

```bash
npm run build
```

在 `~/.config/opencode/opencode.json` 中加入绝对路径（需先 `npm run build`）：

```json
{
  "plugin": ["/absolute/path/to/opencode-atme-proxy"]
}
```

然后重启 `opencode serve`。插件与独立进程共用 `instance.lock`，同一时间只能启动一个。

> 插件模式尚未在真实 OpenCode 1.19.x 上验证。如果本地目录未被识别，可先用 `npm link` 或发布为包；独立守护进程模式已验证可编译、可测试。

### 4. 验证

```bash
npm run probe      # 只拉历史消息并打印，不回复
npm run check      # typecheck + 全部测试
```

启动成功的日志应包含：

```text
runtime started
project resolved
websocket ready
```

最小链路验收：

1. 群里 @机器人：应收到机器人引用回复。
2. 群里 @我：应收到私聊审批卡。
3. 点「代答」：群里出现带「（助手代答）」的引用回复。
4. 非 @ 相关消息：只收到私聊汇总，群里无动静。

### 5. 常见问题

| 现象 | 排查 |
|------|------|
| `Feishu app secret is missing` | `.env` 或 `FEISHU_APP_SECRET` 未设置 |
| `Invalid config` | 字段缺失/类型错误；按报错路径修 |
| `no active project resolved` | 配置 `project.worktree` 或 `project.allowlist` |
| `another instance is running` | 已有进程；先停掉或删陈旧 `instance.lock` |
| `queue is full` | 突发消息过多；提高 `concurrency.maxQueue` 或降低并发 |
| 429 / 限流 | 降低 `rateLimit.sendPerSecond`，检查多实例 |
| 卡片按钮无响应 | 检查 `card.action.trigger` 事件与回调时限 |
| OpenCode 不可用 | 确认 `opencode serve` 与 `opencode.baseUrl` |

### 目录与上下文

`stateDir` 默认 `~/.local/state/opencode-atme-proxy`，主要文件：

```text
dedup.json          消息去重
cursors.json        每群拉取游标
projects.json       群 → 项目绑定
chat-context.json   最近群聊上下文（默认 20 条 / 7 天）
tasks/              任务
analyses/           任务分析（按版本）
approvals/          审批记录
executions/         执行记录
pending.json        待审批卡片
audit.jsonl         审计
instance.lock       单实例锁
worktrees/          执行工作树
```

### 关键配置

```json
{
  "concurrency": {
    "global": 8,
    "mentionConcurrency": 4,
    "scanConcurrency": 1,
    "perChat": 1
  },
  "reply": {
    "defaultStyle": "concise",
    "maxChars": 320,
    "detailMaxChars": 2000,
    "ackDelayMs": 2000
  },
  "policy": {
    "autoReplyOnMention": false,
    "requireMergeApproval": true
  }
}
```

- `concurrency.mentionConcurrency`：同一群内 @ 消息的并发数。
- `concurrency.scanConcurrency`：同一群批量筛选的并发数，默认 1，避免重复上下文。
- `reply.defaultStyle`：默认极简；检测到“详细”等触发词才展开。
- `policy.autoReplyOnMention`：默认关闭，所有 @我 先请示。

### 架构

```text
src/
  core/                 平台无关：并发、去重、游标、任务、审批、执行、审计
  adapters/feishu/      飞书：事件、历史、发送/回复、卡片、映射
  index.ts              OpenCode 插件入口
  cli.ts                独立守护进程入口
  src/scripts/probe-history.ts
tests/                  并发、去重、筛选、状态机、配置、映射
docs/REQUIREMENTS.md    需求文档 v0.2
```

### 安全

- 配置 600；密钥优先环境变量。
- 群消息视为不可信数据；分析/执行分离；执行 Agent 只拿到已批准计划。
- 执行限定 worktree；禁 push/合并/force push/删除仓库（除非显式配置并二次审批）。
- 审计记录追加写，任务不能篡改。

### 已知限制

- 当前只实现飞书适配器；其他平台通过 `PlatformAdapter` 扩展。
- 个人微信无官方 Bot API，不做。
- 飞书“群全量消息”依赖敏感权限，需 M0 实测确认。
- 首期不解析图片/文件内容，只做占位摘要。

### 运行方式

- **独立守护进程（推荐）**：`npm start`，与 OpenCode 生命周期解耦。
- **OpenCode 插件**：构建后把本仓库加入 `opencode.json` 的 `plugin`，插件随 `opencode serve` 启停。
- 两者共用 `instance.lock`，同一时间只允许一个实例，避免重复回复。

### 开发状态

已完成：

- 飞书适配器（WS 事件 + 历史消息 + 发送/回复 + 卡片）
- 并发 @ 调度（同群 4 并发、跨群并行、有界队列、超时/重试）
- 群聊上下文记忆、项目解析与群绑定
- 去重、游标、任务、分析、审批、执行、审计骨架
- 简洁/详细回复策略、审批门禁、失败降级
- 49 个单元/集成测试

未完成 / 下一步：

P0（必须先做）：

- **M0 真实飞书验证**：全量群消息权限、卡片回调时限与 payload、私聊 `open_id` 发送、历史消息时间单位。
- **真实 OpenCode 联调**：`opencode serve` + 实际仓库的审批 → 执行 → 测试 → diff 全链路；执行超时/取消尚未接入。
- **push/PR/合并二次审批**：当前只保留配置，未实现；执行器不会 push。
- **重启恢复**：待审批卡片可恢复；正在执行的会话不会自动续跑。

P1：

- 飞书 429 退避与重试抖动；发送限流已做，接收侧退避未做。
- 预算硬停：token 预算目前是事后告警，未在批次中间硬停；每日执行次数未强制。
- 附件/图片/文件解析（当前只占位）。
- 群内结果回写（默认关闭，未实现）。
- 执行器 worktree 清理策略未接入定时任务。
- 多审批人、审批超时重新发起 UI。
- 插件模式在真实 OpenCode 中的加载验证。
- 集成测试（Mock 飞书服务）与 CI。
- systemd/pm2 部署单元、日志轮转。

P2：

- 第二个平台适配器（Slack/Telegram/DingTalk/企微）。
- 任务跨消息语义合并、任务优先级。
- 上下文摘要（当前只保留最近 N 条原文）。
- Web 审批降级（无卡片平台）。

### 文档

- 需求：`docs/REQUIREMENTS.md`
- 配置示例：`config.example.json`
- 环境变量：`.env.example`

---

## English

### What it is

A platform-agnostic, approval-gated bot framework that:

1. ingests chat messages (mentions, bot mentions, and relevant group messages);
2. filters and extracts tasks with a low-cost model;
3. produces a structured task analysis;
4. waits for explicit approval;
5. lets OpenCode execute the approved plan in an isolated worktree;
6. writes progress and results back, with an audit trail.

### Why

- Group chats are noisy; important tasks get missed.
- Sending every message to the main agent is expensive and risky (prompt injection).
- There is no safe path from “a message” to “code changed” without structured analysis and approval.

### Features

- **Realtime mentions**: `@bot` answers directly; `@me` asks you first, then replies with a quote.
- **Periodic scanning**: history polling + keyword/LLM filtering, private digest only, no group spam.
- **Task loop**: identify → analyze → approve → execute → test → report → audit.
- **Concurrent mentions**: per-chat mention concurrency (default 4), while different chats run in parallel; background scans stay serial to avoid context races.
- **Concise by default**: short answers unless the sender explicitly asks for detail (`详细`, `steps`, `why`, `how`, ...).
- **Approval gate**: no code changes before approval; approval is bound to a plan hash; auto-merge/push is not implemented (config reserved).
- **No silent failure**: filter, approval, and execution failures are reported and persisted.

### Requirements

- Node.js >= 20.11 (verified on 24.x), npm >= 10
- OpenCode 1.x with `opencode serve --port 19876` running
- A Feishu self-built app with the required scopes and long-connection events
- Git (needed for development execution)

### Install

```bash
git clone https://github.com/renyuan000/opencode-atme-proxy.git
cd opencode-atme-proxy.git
npm ci            # use npm install if there is no lockfile
npm run build
```

### Configure

```bash
mkdir -p ~/.config/opencode-atme-proxy
cp config.example.json ~/.config/opencode-atme-proxy/config.json
chmod 600 ~/.config/opencode-atme-proxy/config.json
cp .env.example .env
```

Fill `.env` (never commit it):

```text
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
ATME_ME_OPEN_ID=ou_xxx
ATME_APPROVER_OPEN_IDS=ou_xxx
ATME_FILTER_BASE_URL=https://your-openai-compatible-endpoint/v1
ATME_FILTER_API_KEY=xxx
ATME_FILTER_MODEL=your-low-cost-model
ATME_OPENCODE_URL=http://127.0.0.1:19876
```

Required `config.json` fields:

| Field | Meaning |
|-------|---------|
| `platforms.feishu.appId` | Feishu App ID (`cli_...`) |
| `platforms.feishu.me.openId` | Your `open_id` (`ou_...`) |
| `platforms.feishu.approvers[0].openId` | Approver `open_id`, usually you |
| `platforms.feishu.groups[].chatId` | Group `chat_id` (`oc_...`) |
| `filter.baseUrl/model` | OpenAI-compatible low-cost model |
| `opencode.baseUrl` | `http://127.0.0.1:19876` |
| `project.worktree` | Main repo path; optional if auto-resolution works |
| `repos[]` | Optional repo allowlist plus test/lint commands |

Feishu console:

1. Event subscription: long connection, add `im.message.receive_v1` and `card.action.trigger`.
2. Scopes: `im:message.group_at_msg:readonly`, `im:message.group_msg` (sensitive, admin approval), `im:message:send_as_bot`; optional `contact:user.base:readonly`.
3. Add the bot to the target groups.

### Run

Standalone daemon (recommended):

```bash
npm start
```

Background:

```bash
nohup npm start >> ~/.local/state/opencode-atme-proxy/daemon.log 2>&1 &
```

Dev mode:

```bash
npm run dev
```

OpenCode plugin mode:

```bash
npm run build
```

Add the absolute path to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["/absolute/path/to/opencode-atme-proxy"]
}
```

Restart `opencode serve`. The plugin and the daemon share `instance.lock`, so only one can run at a time.

> Plugin mode has not been verified on a real OpenCode 1.19.x yet. If the local directory is not recognized, use `npm link` or publish the package first. The standalone daemon is build/test verified.

### Verify

```bash
npm run probe      # print history only, no replies
npm run check      # typecheck + tests
```

Expected startup logs: `runtime started`, `project resolved`, `websocket ready`.

Minimum acceptance:

1. `@bot` in a group -> bot replies with a quote.
2. `@me` -> private approval card.
3. Click "reply on my behalf" -> group gets a quoted reply prefixed with `（助手代答）`.
4. Relevant non-mention message -> private digest only, no group message.

### Project context

The bot speaks as a chat assistant in Feishu and as an architect/lead engineer in OpenCode. It must work in the right repository, not in a user home directory.

Resolution order: explicit `project.worktree` → `project.id` → project with recent sessions → most recently updated git project → `repos[0].path` → `fallbackWorktree`.

It ignores the `global` project (worktree `/` or home), binds each chat to a resolved project (`projects.json`), and can be constrained with `project.allowlist`.

Recent chat context (20 messages, 7 days by default) is used only for answering and task analysis; it is configurable under `context`.

### Architecture

```text
src/core/              platform-agnostic: concurrency, dedup, cursor, task, approval, execution, audit
src/adapters/feishu/   Feishu: events, history, send/reply, cards, mapping
src/index.ts           OpenCode plugin entry
src/cli.ts             standalone daemon entry
tests/                 concurrency, dedup, filtering, state machine, config, mapping
docs/REQUIREMENTS.md   requirements v0.2
```

### Security

- Config is 600; secrets come from env first.
- Messages are untrusted data; analysis and execution are separated; the executing agent only sees the approved plan.
- Execution is restricted to a worktree; no push/merge/force-push/repo deletion unless explicitly configured and approved.
- Append-only audit log.

### Limitations

- Feishu adapter first; other platforms implement `PlatformAdapter`.
- Personal WeChat is not supported (no official bot API).
- Feishu “all group messages” needs a sensitive scope; confirm in M0.
- No image/file content parsing in the first release; placeholders only.
- Push/PR/merge is not implemented; the executor never pushes.
- Running executions are not resumed after a restart.

### Roadmap

P0:

- Real Feishu M0 validation (all group messages, card callback, private DM, history time units).
- Real OpenCode end-to-end (approve → execute → test → diff); execution timeout/cancel.
- Push/PR/merge with second approval.
- Crash recovery for running executions.

P1:

- Feishu 429 backoff and jitter; receive-side retry.
- Hard token/execution budgets.
- Attachment parsing (images/files), group write-back.
- Worktree cleanup, multi-approver, plugin-mode verification.
- Mock Feishu integration tests + CI, systemd/pm2 units.

P2:

- Second adapter (Slack/Telegram/DingTalk/WeCom).
- Semantic task merging and priority.
- Context summarization.
- Web approval fallback.

### Docs

- Requirements: `docs/REQUIREMENTS.md`
- Config example: `config.example.json`
- Env example: `.env.example`
