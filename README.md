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

- **私聊对话**：和机器人单独聊天会直接回复（默认仅限 owner）。
- **私聊改稿**：审批卡发出后，可私聊 `/列表`、`/改写 <新内容>`、`/重写 <要求>`、`/发送`、`/取消 [编号|taskId]`；`/帮助` 查看命令。
- **群职责画像**：私聊 `/职责 <群名|chatId> <说明>` 设置本群主职责、依赖和排除项，并注入筛选、回复和分析上下文；`/画像 [群名|chatId]` 查看初始/当前群画像。
- **我的研发方向**：私聊 `/方向 <群名|chatId> <说明>`、`/关键词 <群名|chatId> <kw1,kw2>` 设置我在该群的研发方向和关键词；分诊会额外判断归属 `ours/external/unclear`，外部/平台问题不会自动建开发任务；同一话题的图片/文件/文字会优先合并。
- **私聊目标选择**：私聊 `/目标` 查看最近目标，`/目标 <编号|chatId|messageId>` 选择当前目标。
- **私聊目标绑定**：群内待确认消息会记录 `chatId/chatName/messageId`；私聊跟进未引用时自动带上最近目标；多个目标只列候选，不猜。
- **群工作空间**：一个群对应一个工作空间，代码项目平级放在 `worktrees/`，分析/文件/执行产物都留在群工作空间；不再强制“一个主仓 + 关联仓”。
- **工作空间管理**：主人私聊 `/工作空间 <群名|chatId> ...` 即可查看、设置根目录、添加/删除项目、配置 test/lint、自动发现；不需要改代码。
- **配置诊断**：主人私聊 `/诊断 <群名|chatId>` 会检查项目路径是否存在、是否在 OpenCode `fs-root` 白名单，并给出具体配置修改建议；私聊回复命中权限/目录错误时也会自动附上诊断。
- **任务管理**：`/任务 [群名] [状态] [数量]` 查看；`/任务分析 [群名|taskId]` 后台重跑；`/任务归档 ...` 归档；`/任务清理 ... 确认` 真正删除；`/任务恢复 <taskId>` 恢复；`/任务会话 <taskId>` 查看关联 session。任务、消息/卡片/session 映射和事件写入每群 `cache/state.db`（SQLite），旧 JSON 首次启动导入。
- **任务归档**：默认 14 天未处理的 `candidate`、90 天未更新的 `needs_info`、30 天的待审批、90 天的终态任务自动归档；只写 `archivedAt`，不删除任务、审计和分析文件。
- **任务映射**：每群 `cache/state.db` 保存任务快照、消息/卡片到 taskId 的映射、session 到 taskId 的多对一映射、任务通知和生命周期事件；SQLite 为运行时事实源，旧 JSON 只做一次性导入。
- **私聊承接**：候选/审批通知会记录 `task_notifications`；私聊 prompt 注入最近通知摘要，普通 DM 的“刚才/继续/补充/这个文档”等指代可在私聊 active task 上继续处理。
- **运行监测**：`task_runs` 记录分析/执行/评审心跳和 lease；5 分钟无心跳会标记 stalled 并私聊提醒，分析/执行 prompt 有阶段超时。
- **owner 私聊权限**：owner DM 允许 bash/联网，但禁止 edit；外部路径改为 ask；内置高风险命令 ask 规则（rm -rf 根目录、mkfs、dd、shutdown、force push、reset --hard、drop database 等），并固定 deny `rm -rf` 主要源码目录 `/mnt/d/Work/source*`、`/home/renyuan/*.git`；通过私聊 `/允许 <id>` / `/拒绝 <id>`，或直接回复“允许/拒绝/行/OK/好/不好/反对”等自然语言回复 OpenCode 权限请求。
- **多项目开发**：任务分析会列出工作空间内项目；执行时为涉及项目分别创建独立 git worktree，避免直接修改源仓库。
- **会话代际**：群职责/画像/术语变化、私聊偏好/决策变化时自动升 `sessionEpoch`，新会话不复用旧上下文。
- **命令提示**：私聊发送 `/`、`／`、`?`、`？` 会返回命令列表（含 `/回复管理`、`/职责`、`/诊断`、`/任务`、`/任务整理`、`/任务分析`、`/任务归档`、`/任务清理`、`/分析`、`/群消息`、`/群消息分析`）。飞书不支持输入框斜杠自动补全，必须发送后才触发。
- **私聊查群消息**：`/群消息 <群名关键词> [关键词] [数量]` 可以查询机器人所在群的最近消息；`/群消息分析 <群名关键词> [数量]` 主动生成群消息分析卡片；`/提及 <群名关键词> [数量]` 只查 @我/@机器人 的消息。不需要输入 chatId。
- **卡片回复管理**：代答审批卡和开发审批卡都有「回复管理」，可看待审批草稿和最近 5 条可撤回回复；每条带群/发送人/时间/内容。撤回后原回复会重新变成待审批草稿，可 `/改写`、`/重写` 或 `/发送`。
- **回执优先**：对方只是确认或同意时，只回“收到”，不分析、不查资料、不追问。
- **快速回执**：@机器人/@我/owner 私聊收到后，机器人先给消息加一个表情（默认 `OK`，`reply.ackReaction` 可改；设为空字符串关闭）。
- **撤回中断**：订阅飞书 `im.message.recalled_v1` 后，消息被撤回会 abort 正在进行的处理，跳过后续回复，并把群/私聊上下文、证据和任务补充中的正文脱敏为 `[已撤回]`。
- **回复必要性**：通知、公告、闲聊、已有答案或与 owner 无关的消息不代答；模糊时用小模型判定。
- **引用解析**：对方回复某条消息时，自动带上被回复消息与同线程上下文，短指代优先在该范围内解析。
- **媒体上下文关联**：同一发送人、时间相近、中间无其他人发言的前置图片/文件会作为候选；本地 OCR 后由 LLM 判断是否同一事项，命中才并入当前 @ 上下文；@我 任务分析复用同一媒体簇，前置图片和文件内容都会进入任务分析；私聊通知优先给原消息 AppLink，失败回退群 AppLink，不生成附件副本。
- **群摘要**：每群一个持久摘要会话，保留决策、被否决方案、假设、未解决问题，以及讨论主题/阶段；摘要按新增消息密度/字符量/信号触发，低密度消息不反复摘要，失败后 5 分钟退避。
- **私聊长期上下文**：owner 私聊独立保存摘要、偏好、决策、目标、未解决问题和 `sessionEpoch`，并注入私聊回复。
- **证据回查**：普通群消息按月存 `groups/<群名__短ID>/replies/<YYYY-MM>.jsonl`，并维护 `pointer.json`；记录包含 `replyToMessageId/threadId`，支持本地 `findReplyChain`（最多 5 层）和 `findMessageChain`（回复链 + 同线程混合）及按需回查最近 7 天原文。Evidence 写入使用异步队列，`index.jsonl` 为可重建索引；索引缺失、为空或查不到时回退扫描月度文件。进程停止时会 flush。
- **图片理解**：@我/@机器人 的图片会下载为视觉附件交给支持图片的 OpenCode 模型；最多 2 张、单张 3MB。非 @ 群消息扫描也会对图片做 OCR；默认优先本地 RapidOCR，失败回退 `tesseract`（需安装 `tesseract` 和 `chi_sim` 语言包）；OCR 结果按采样指纹缓存，并做并发 in-flight 去重；浅层扫描对近似截图用 dHash 复用识别结果。

OCR 可选安装（推荐，中文截图更准）：

```bash
python3 -m venv ~/.local/share/atme-ocr-venv
~/.local/share/atme-ocr-venv/bin/pip install rapidocr_onnxruntime
```

`ocr.provider` 可取 `auto`、`rapidocr`、`tesseract`；默认 `auto`，没有 RapidOCR 时自动回退 Tesseract。
- **文件关联**：引用链最多回溯 5 层；最近 24 小时群文件不限定发送人，最多读取 2 个。支持 docx/pdf/doc/html/xlsx/xls/txt/md/csv/json 等；doc 用 `antiword`，xlsx/xls 用 SheetJS，docx 优先 `pandoc` 再回退 `unzip`。非 @ 群媒体先本地 OCR/文本提取并判断相关性，深层分析需私聊 `/分析 <taskId>` 批准，不自动执行；不会把原文件/图片转发成副本。
- **在线文档**：按 @消息/引用里的 `/docx/`、`/wiki/`、`/docs/`、`/sheets/` 读取正文；wiki 下的 sheet 也支持。
- **联网策略**：群聊默认禁用 `websearch/webfetch`；主人私聊默认允许 `websearch`，`webfetch` 需要私聊明确说“允许抓取/允许联网”。

- **消息类型识别**：@机器人 先判断是询问、任务、提醒、通知还是闲聊，再决定动作。
- **发言必要性评估**：@机器人 不必然回复。一次 LLM 同时判断 `answer / need_decision / notify_owner / no_reply` 并生成回复；无需介入就不吭声，避免刷屏。
- **防刷屏**：按发送者限流、限并发、加冷却；同一人连续刷只警告一次，不同同事仍可并发处理。
- **需要你决策时私聊请示**：涉及上线、排期、承诺、资源、风险或信息不足时，机器人私聊你，附来源、原因和建议；不在群里 @ 你，不代替你承诺。
- **实时 @ 接管**：@机器人 按必要性直接回答或升级；@我 默认先私聊请示，批准后引用回复。
- **周期筛选**：定时拉取群历史，先用本地规则做初筛（@别人、核心项目/协议/性能/Kafka 信号、外部平台/页面/adapter/service 信号），再交给筛选模型；强外部消息不通知、不深分析。
- **归属与分层**：筛选结果分开输出 `ownership` 和 `layer`（web_ui/service/pg/kafka/engine/protocol/performance/deploy），避免把“页面问题”直接判成外部。
- **友好摘要**：群消息分析私聊优先使用卡片，每条消息独立分块并用分隔线，优先附原消息 AppLink，失败回退群聊 AppLink；不把原图片/文件复制到私聊；摘要正文不暴露 `ou_` 和 `message_id`。
- **任务闭环**：任务识别 → 分析 → 审批 → 开发 → 测试 → 回写 → 审计。
- **并发 @**：不同群并行、同一群 @ 消息并发（默认 4）、批量筛选串行，避免互相拖慢。
- **简洁回复**：默认极简；只有对方明确说“详细/展开/步骤/why/how”等才展开。
- **审批门禁**：未批准不改代码；批准绑定计划哈希；自动合并/推送未实现，配置保留。
- **回复补充**：主人直接回复审批卡或任务来源消息，会自动追加到对应任务；待审批/需补充状态会重新分析，执行中只记录补充、不会中途改变当前执行。
- **审批卡信息**：开发审批卡显示群名、原消息链接、范围、计划文件和执行计划；批准后结果卡保留原始上下文。
- **失败不静默**：筛选失败、审批超时、分析失败、执行失败都会私聊告警并保留状态；分析失败会提示 `/分析 <taskId>` 重试。筛选告警会区分“模型请求超时 / 任务整体超时 / 连接中断 / 输出格式错误”，并附带模型、技术原因和 `proxy.log` 路径。

### 项目定位与上下文

机器人在飞书里是“机器人助手”，在 OpenCode 里是“架构师 + 研发负责人”：

- 它需要知道当前工作空间/代码目录，而不是在 `/mnt/c/Users/...` 里凭空回答。
- 优先级：群 `workspace` → 群 `project.primary/core` → `project.worktree`（显式）→ `project.id` → 最近有会话的 git 项目 → 最近更新的 git 项目 → `repos[0].path` → `fallbackWorktree`。
- `workspace` 模式下，OpenCode 主目录是群工作空间；`worktrees/` 下代码项目平级，没有 primary/core 主次。
- 默认会忽略 `global` 项目（worktree 为 `/` 或 home 目录），避免在用户目录下开发。
- 群 `workspace` 模式下，后续同一群的对话、分析、执行都使用该工作空间；旧模式才会把群绑定到单个项目（`projects.json`）。
- 可用 `project.allowlist` 限制只能在哪些仓库下工作，防止越界。
- 解析结果写入日志：`projectId / worktree / reason / score`，便于排查“为什么选了这个项目”。
- 群聊上下文默认保留最近 50 条逻辑消息、7 天，用于回答、任务分析与历史关联，不写进群；可在 `context` 中关闭。

### 环境要求

- Node.js ≥ 20.11（已在 24.x 验证），npm ≥ 10
- OpenCode 1.x，且 `opencode serve --port 19876` 已启动
- 飞书自建应用，已开通所需权限与长连接事件
- Git（开发执行需要）
- WSL2 下无需入站端口；机器人只主动连飞书和 localhost OpenCode

### 1. 安装

未发布到 npm registry；在线安装走 GitHub，不要用 `npm install -g opencode-atme-proxy`（会 404）。

临时试用，不装到全局：

```bash
npm exec --yes --package=github:renyuan000/opencode-atme-proxy atme-proxy -- version
```

把 `version` 换成 `setup`、`agents`、`doctor` 即可。

全局安装（推荐）：

```bash
npm install -g github:renyuan000/opencode-atme-proxy
```

安装后一键初始化（配置 + agent + 群同步 + 检查）：

```bash
atme-proxy init
# 或临时试用：npm exec --yes --package=github:renyuan000/opencode-atme-proxy atme-proxy -- init
```

`init` 会复用已有配置；要重跑向导加 `--force`。

或安装到本地项目：

```bash
npm install github:renyuan000/opencode-atme-proxy
npx atme-proxy version
```

安装脚本说明：

- 仓库已带预构建 `dist/`，`prepare` 找不到 `tsc` 或构建失败时会直接使用 `dist`，不会因缺开发依赖失败。
- npm 11 仍可能提示 `install-scripts ... allowScripts`；这是安全提示，不是错误。
- `npm exec` 的安装目录是缓存，可能被清理；**长期运行/配置 systemd 请用全局安装或 clone**，不要把 systemd 指向 `_npx` 路径。
- `deploy/systemd/*.service` 是示例；`install.sh` 会按当前环境重新生成 unit。
- 如果公司 npm 策略禁止 `prepare`，直接克隆安装：

```bash
git clone https://github.com/renyuan000/opencode-atme-proxy.git
cd opencode-atme-proxy.git
npm ci
npm run build
npm link
```

手动构建（一般不需要）：

```bash
git clone https://github.com/renyuan000/opencode-atme-proxy.git
cd opencode-atme-proxy.git
npm ci
npm run build
npm link          # 可选，让 atme-proxy 进入 PATH
```

安装 agent 定义（子会话需要）：

```bash
atme-proxy agents
# 或 npx atme-proxy agents
```

这会把 `atme-analyst.md`、`atme-executor.md`、`atme-reviewer.md` 复制到 `~/.config/opencode/agents/`。

`node_modules/`、`dist/`、`.env`、`*.tgz` 已在 `.gitignore` 中，不会提交。

### 2. 配置（推荐用 setup）

```bash
atme-proxy setup
```

向导支持两种方式：

1. **扫码自动创建机器人应用（推荐）**：调用飞书 `registerApp`，扫码后直接创建带机器人能力、权限、事件和卡片回调的应用，并返回 App ID / App Secret / 你的 open_id。
2. **手动输入**：已有应用时使用。

扫码会预填：

- 机器人能力（`preset: false` 的最小机器人模板）
- scopes：`im:message.group_at_msg:readonly`、`im:message.group_msg`、`im:message.p2p_msg:readonly`、`im:message:readonly`、`im:message:send_as_bot`、`im:chat:readonly`、`im:chat.members:bot_access`、`sheets:spreadsheet:readonly`、`docx:document:readonly`、`wiki:wiki:readonly`、`im:resource`、`contact:user.base:readonly`
- 事件：`im.message.receive_v1`、`im.chat.member.bot.added_v1`、`im.chat.member.bot.deleted_v1`、`im.chat.updated_v1`
- 回调：`card.action.trigger`

仍需你在飞书确认/完成：**敏感权限 `im:message.group_msg` 需要管理员审批**；发布应用、把机器人拉进群。

向导会写入：

- `~/.config/opencode-atme-proxy/config.json`（600）
- `~/.config/opencode-atme-proxy/.env`（600）

非交互模式（适合脚本）：

```bash
export FEISHU_APP_ID=cli_xxx
export FEISHU_APP_SECRET=xxx
export ATME_ME_OPEN_ID=ou_xxx
export ATME_APPROVER_OPEN_IDS=ou_xxx
export ATME_FILTER_BASE_URL=https://your-endpoint/v1
export ATME_FILTER_MODEL=your-low-cost-model
export ATME_FILTER_API_KEY=xxx
atme-proxy setup --yes
```

检查：

```bash
atme-proxy doctor
```

手动配置（不使用向导）：

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

| 字段                                   | 说明                                     |
|----------------------------------------|------------------------------------------|
| `platforms.feishu.appId`               | 飞书 App ID（`cli_` 开头）                 |
| `platforms.feishu.me.openId`           | 我的 open_id（`ou_` 开头）                 |
| `platforms.feishu.approvers[0].openId` | 审批人 open_id，通常是我                  |
| `platforms.feishu.groups[].chatId`     | 群 chat_id（`oc_` 开头），可多个            |
| `filter.baseUrl/model`                 | OpenAI 兼容的低成本模型                  |
| `filter.timeoutMs`                     | 筛选模型超时，默认 60000ms               |
| `opencode.filterModel`                 | 筛选专用模型；不配则复用已有 OpenCode session 的模型 |
| `opencode.baseUrl`                     | `http://127.0.0.1:19876`                 |
| `groups[].workspace`                   | 群工作空间：root/projects/docs；优先于 project |
| `project.worktree`                     | 旧模式主项目代码目录；不填则自动解析      |
| `repos[]`                              | 旧模式开发执行仓库白名单、测试/lint 命令  |
| `context.storeMediaPlaceholders`       | 非 @ 的图片/文件等也存占位符，默认 true   |
| `evidence.retentionDays`               | 群证据保留天数，默认 720                  |
| `groupSession.summaryEveryMessages`    | 每 N 条消息更新群摘要，默认 8             |
| `context.storeAllGroupMessages`        | 普通群文本也存上下文与证据，默认 true     |

**owner（“我”）怎么确定**

机器人绝不会猜“谁是我”，也不会因为有人在群里说“我是”就相信。三种方式，优先级从高到低：

1. **预配置**：`platforms.feishu.me.openId` 或 `approvers[0].openId`。
2. **私聊一次性绑定码**：配置 `ATME_CLAIM_CODE`（或 `bootstrap.claimCode`），在飞书私聊机器人发送该码。只能绑定一次；已有 owner 时不会被覆盖；错误尝试有频率限制。
3. 未配置 owner 时启动直接失败，不会进入“谁都能冒充”的状态。

绑定结果写入 `~/.local/state/opencode-atme-proxy/owner.json`，后续 @ 升级、审批私聊、代答推送都发给这个账号。

飞书后台配置：

1. 事件订阅选择「长连接」，添加 `im.message.receive_v1`、`card.action.trigger`。
2. 权限：`im:message.group_at_msg:readonly`、`im:message.group_msg`（敏感，需管理员审批）、`im:message:send_as_bot`；可选 `im:message.p2p_msg:readonly`（仅私聊 claim 需要）、`contact:user.base:readonly`。
3. 把机器人拉进目标群，然后运行 `atme-proxy chats --sync`，自动发现群 `chat_id` 和真实群名并写入配置。
4. 重启后，日志里的 `chatName` 会显示真实群名（首次收到消息时按 `chat_id` 查询并缓存）。

如果后台有 `im.chat.member.bot.added_v1` 事件，插件也会在加群时自动白名单并私聊通知；没有该事件不影响使用。
4. 以上 scope 名称以飞书开放平台后台实际可选项为准；`im:message.group_msg` 需管理员审批。

项目上下文：

- 推荐用群 `workspace` 指定工作空间和代码项目；旧模式可显式配置 `project.worktree`。
- 旧模式不配置时自动选择：最近有会话的 git 项目 → 最近更新项目 → `repos[0].path`；会忽略 `global`（`/` 或 home）。
- 旧模式建议配置 `project.allowlist`，限制只能在指定仓库下工作；workspace 模式由项目列表限定。

回复与并发：

- `reply.defaultStyle=concise`，默认 ≤320 字；对方说「详细/展开/步骤/why/how」才展开。
- `concurrency.mentionConcurrency=4`：同一群 @ 消息并发数。
- `concurrency.scanConcurrency=1`：同群批量筛选串行，避免上下文串台。

### 2.1 关于“配置 LLM”

- **OpenCode 已配置的模型**用于：群回复、任务分析、开发执行、评审。这部分不用重复配置，只要 `opencode serve` 在跑。
- **批量筛选**默认用 OpenCode 的主模型（`filter.mode="opencode"`），不需要额外配置 baseUrl/API Key。
- 想省钱可改成独立低成本模型：`filter.mode="external"`，再配 `baseUrl/model/apiKey`。
- 如果你想先用起来、不想单独配筛选模型：把 `filter.enabled` 设为 `false`，@ 消息仍会走 OpenCode 主模型，但周期筛选会关闭。
- OpenCode 模式下筛选超时由 `filter.timeoutMs` 控制；超时会快速失败并保留消息待重试，不再等满整个扫描任务。
- 你的 OpenCode 已配好，**不需要再配一遍模型**；`setup` 里的“低成本模型”是可选项。
### 2.1.1 模型配置总览

插件里显式配置模型的位置有四类：

| 用途 | 配置 | 说明 |
|------|------|------|
| 筛选（OpenCode） | `opencode.filterModel` | 不配时复用最近直接 OpenCode session 的模型；再不行才用 OpenCode 默认模型 |
| 筛选（独立网关） | `filter.model` + `filter.baseUrl` | `filter.mode=external` 时使用 |
| 群回复/代答 | `opencode.replyModel` | reply worker 的模型；不配则用 OpenCode/agent 默认模型 |
| 任务分析/核实 | `analysis.model` | analysis 与 analysis-check worker 的模型；不配则用 OpenCode/agent 默认模型 |

执行/评审如果未显式配置模型，最终由 OpenCode 的 `executionAgent`/`reviewer` 或 OpenCode 默认模型决定。

筛选失败告警会带上实际使用的 `provider/model`、失败原因和日志路径。

### 3. 启动

独立守护进程（推荐）：

```bash
npm start
```

后台运行示例：

```bash
nohup npm start >> ~/.local/state/opencode-atme-proxy/daemon.log 2>&1 &
```

### 3.1 开机自启（WSL2 + systemd）

WSL2 已启用 systemd 时，用仓库自带安装脚本：

```bash
sudo bash deploy/systemd/install.sh
```

脚本会按当前环境**生成**两个 unit，而不是复制固定路径；`deploy/systemd/*.service` 仅作示例。长期服务请用全局安装或 clone，不要用 `npm exec` 的临时缓存路径。

- `opencode-serve.service`：`opencode serve --port 19876`
- `atme-proxy.service`：`node <repo>/dist/cli.js start`，依赖前者

默认使用 `sudo` 前的用户、当前仓库路径、当前 `node`/`opencode`；需要覆盖时：

```bash
sudo ATME_SERVICE_USER=myuser ATME_REPO_DIR=/path/to/repo \
  ATME_NODE_BIN=/path/to/node ATME_OPENCODE_BIN=/path/to/opencode \
  bash deploy/systemd/install.sh
```

`atme-proxy init` / `setup` 结束时会提示这条自启命令。服务读取该用户的默认配置（`~/.config/opencode-atme-proxy/config.json`），所以请用运行机器人服务的同一用户执行 init/setup。

日志用 journald：

```bash
journalctl -u opencode-serve -f
journalctl -u atme-proxy -f
```

如果 WSL 没启用 systemd，先在 `/etc/wsl.conf` 加：

```ini
[boot]
systemd=true
```

然后在 Windows PowerShell 执行 `wsl --shutdown`，重开 WSL。

Windows 登录时自动拉起 WSL：任务计划程序 → 创建任务 → 触发器“登录时” → 操作 `C:\Windows\System32\wsl.exe`，参数：

```text
-d <发行版名> -u root --exec /bin/true
```

发行版名用 `wsl.exe -l -v` 查看。安装脚本会按当前用户、仓库路径和可执行文件位置生成 unit；换环境时重新运行脚本或用上面的 `ATME_*` 变量覆盖。

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

先跑本地模拟（无需飞书凭据）：

```bash
npm run demo
```

再跑真实飞书最小流程：

```bash
npm run probe      # 只拉历史消息并打印，不回复
npm run check      # typecheck + 全部测试
```

完整步骤见 `docs/DEMO.md`。

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

| 现象                           | 排查                                                |
|--------------------------------|-----------------------------------------------------|
| `Feishu app secret is missing` | `.env` 或 `FEISHU_APP_SECRET` 未设置                |
| `Invalid config`               | 字段缺失/类型错误；按报错路径修                      |
| `no active project resolved`   | 配置 `project.worktree` 或 `project.allowlist`      |
| `another instance is running`  | 已有进程；先停掉或删陈旧 `instance.lock`             |
| `queue is full`                | 突发消息过多；提高 `concurrency.maxQueue` 或降低并发 |
| 429 / 限流                     | 降低 `rateLimit.sendPerSecond`，检查多实例           |
| 卡片按钮无响应                 | 检查 `card.action.trigger` 事件与回调时限           |
| OpenCode 不可用                | 确认 `opencode serve` 与 `opencode.baseUrl`         |

### 会话架构（当前实现 v0.2）

> 会话模型：一个 conversation 一个锚点；群和私聊都是独立 conversation。详见 `docs/MEMORY-DESIGN.md` 与 `docs/SESSION-ARCHITECTURE-REVIEW.md` 第 12 节。

- 每个群一个 coordinator session，只作锚点，不跑 prompt，避免 `SessionBusyError`。
- 每个私聊 conversation 一个 coordinator session；单 owner、单机器人时通常就是一个 owner DM。
- 每个 conversation 一个持久摘要/上下文会话，维护长期摘要与决策。
- `reply`、`analysis`、`review` 复用每个 conversation 的持久 worker，同一 worker 串行执行 job。
- `execution` 仍是每任务临时 child，在独立 worktree 中执行。
- 不存在“所有群共用一个全局 LLM session”的设计。
- worker 与群摘要会话不参与 7/30 清理；execution child 完成 7 天归档、30 天删除。
- 关闭 `subagents.enabled` 可退回“每条消息独立 session”的旧行为。
- 内置三个 agent 定义：`.opencode/agents/atme-analyst.md`、`atme-executor.md`、`atme-reviewer.md`。

### 架构评审：会话与并发

详细评审见 `docs/SESSION-ARCHITECTURE-REVIEW.md`。结论：

- **采纳**：每个 conversation 一个 coordinator 锚点 + 持久摘要/上下文会话；reply/analysis/review 每 conversation 持久 worker，execution 每任务临时 child。
- **不采纳**：全局 LLM 主 session、按人拆 subagent、用 subagent 做轮询、主 session 存聊天历史、每条消息建 root session。
- **快慢路径分离**：分类/必要性/通知走快路径（秒级）；分析/执行/评审走 child（分钟级，不阻塞）。
- **生命周期**：root 长期保留；child 完成 7 天归档、30 天删除；每任务最多 3 个 child，全局 8，depth=1。

### 上下文与关键信息记忆

分三层，避免把没用的聊天都存下来：

| 层           | 文件                | 存什么                                                                   | 默认              |
|--------------|---------------------|--------------------------------------------------------------------------|-------------------|
| 聊天上下文   | `groups/<群名__短ID>/chat-context.json` | 群内文本消息（纯表情/回执除外）、@消息、媒体占位符                           | 每群 50 条 / 7 天 |
| 关键信息记忆 | `groups/<群名__短ID>/memory/` | 任务、决策、事实、偏好、截止时间、结论；主动 upsert、可 pin、可 TTL              | 2000 条 / 90 天   |
| 运行日志     | stderr / `logFile`  | `messageId/chatId/类型/结果` 等元数据，**最多 80 字预览（明显凭据已掩码）** | 关                |

- 普通群消息：除了纯表情/回执，全部进 `chat-context.json` 和 `groups/<群名__短ID>/replies/<YYYY-MM>.jsonl`；AI 需要时回查最近 7 天原文。
- 关键信息在 @ 消息处理、任务分析后主动提取；回答和任务分析会注入相关记忆。
- 热上下文只保留最近 50 条/7 天；历史证据按月 JSONL 保存并维护 active pointer，日志只记最多 80 字脱敏预览，不写全文。

### 重启恢复与不重复

WSL2 可能随时重启，插件启动时会做四件事：

1. **同步机器人所在群**：启动时调用飞书群列表，把新加入的群补进本次白名单（`autoSyncGroups` 默认 `true`）。
2. **补拉最近的 @我 / @机器人 消息**：`recovery.lookbackSeconds` 默认 6 小时。
3. **少量补拉非 @ 的群消息**：每个群最多 `maxPlainMessagesPerGroup` 条（默认 50），只做项目相关筛选，不刷屏。
4. **续作未完成任务**：`analyzing` 重新分析；`candidate` 保留待 owner 按需整理，不自动分析；`awaiting_approval/needs_info` 到期提醒；`executing/verifying` 若超过 `staleRunningMinutes` 则标记中断并等你重新批准，**不会自动重放代码修改**。

去重记录的是什么：

- `dedup.json`：`platform:message_id -> 成功处理时间`，只记消息级，不存正文。
- `cursors.json`：每个群的 `lastEndTime`（上一轮成功窗口结束时间）+ 该窗口最后一条消息的 `lastMessageId / lastMessageTime`。
- 拉取从 `游标 - overlap` 开始；整批消息（含 @消息）全部处理成功后才推进游标，失败则保持原位。
- `outbound.json`：出站消息幂等键，防止重复发送。

不重复的关键：

- 只有成功回复/通知后才写入去重；发送失败下次会重试。
- 出站消息带稳定 `uuid`，飞书侧幂等；本地 `outbound.json` 再兜底。
- 已 `done/rejected/canceled` 的任务不会重跑。
- `queued`、超时、失败的消息保持未处理，下次补拉会继续。

配置项：

```json
{
  "recovery": {
    "enabled": true,
    "onStartup": true,
    "lookbackSeconds": 21600,
    "maxMessages": 200,
    "maxPlainMessagesPerGroup": 50,
    "includeMentions": true,
    "includeRelevantPlain": true,
    "resumeTasks": true,
    "resumeMaxAgeDays": 7,
    "staleRunningMinutes": 30,
    "nudgeHours": 24
  }
}
```

### 目录与上下文

`stateDir` 默认 `~/.local/state/opencode-atme-proxy`。群数据按 `群名__短ID` 物理隔离：

```text
groups/<群名__短ID>/
  group.json          群身份、项目、职责
  group-knowledge.json  初始/持续演进的群画像
  group-knowledge-history.jsonl 群画像变更历史
  chat-context.json   本群最近上下文（默认 50 条 / 7 天）
  group-context.json  本群摘要
  memory.json         本群记忆兼容文件
  document-cache.json 在线文档正文缓存（7 天）
  document-refs.json  在线文档 URL/来源记录（90 天）
  memory/             本群记忆分片 + history/
  replies/            本群证据（YYYY-MM.jsonl + pointer.json + index.jsonl）
  evidence/           本群历史聊天证据
  tasks/              本群任务
  jobs/               本群持久任务记录
  analyses/           本群分析
  approvals/          本群审批
  executions/         本群执行
  reviews/            本群评审
  pending.json        本群待审批卡
  sessions.json       本群 coordinator/group/worker/child 映射
  sent-replies.json   本群已发送回复
  cursors.json        本群游标
  dedup.json          本群去重
  outbound.json       本群发送幂等
  history-mentions.json 本群历史 mention
  audit.jsonl         本群审计
```

全局只保留 `owner.json`、`owner-target.json`、`groups/` 和运行锁/日志。群业务根目录在 `/mnt/d/Work/atme-groups/<群名__短ID>/`，包含 `session/`、`files/`、`docs/`、`worktrees/`、`analysis/`、`execution/`；群名变更只更新 `group.json` 和 `aliases/`，不改目录。

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
    "ackDelayMs": 2000,
    "ackReaction": "OK"
  },
  "policy": {
    "autoReplyOnMention": false,
    "requireMergeApproval": true
  }
}
```

- `concurrency.mentionConcurrency`：同一群内 @ 消息的并发数。
- `botReply.perSenderPerMinute` / `perSenderConcurrent` / `cooldownSeconds`：单个同事的刷屏保护。
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
- 真实飞书/真实 OpenCode 的完整闭环仍需持续验证；大仓库分析仍可能超时。

### 运行方式与目录

- **独立守护进程（推荐）**：`npm start`，与 OpenCode 生命周期解耦。
- **OpenCode 插件**：构建后把本仓库加入 `opencode.json` 的 `plugin`，插件随 `opencode serve` 启停。
- 两者共用 `instance.lock`，同一时间只允许一个实例，避免重复回复。
- 配置默认在 `~/.config/opencode-atme-proxy/config.json`；状态默认在 `~/.local/state/opencode-atme-proxy`。
- 进程 cwd 不强制切换；但每个 OpenCode 会话都显式使用项目代码目录 `directory`，所以会话归属项目，不归属启动目录。
- 会话默认保留（`opencode.keepSessions=true`），可在 OpenCode session 列表里看到；标题前缀 `atme:`。设为 `false` 才会用完即删。
- 目录解析：群 `workspace` → 旧群 `project` → 显式 `project.worktree` → `project.id` → 最近有会话的 git 项目 → 最近更新项目 → `repos[0].path` → `fallbackWorktree`；不会用 home/cwd 代替项目。

### 开发状态

已完成：

- 飞书适配器（WS 事件 + 历史消息 + 发送/回复 + 卡片）
- 群工作空间、多项目分析、按项目 worktree 执行、项目级 test/lint
- 并发 @ 调度（同群 4 并发、跨群并行、有界队列、超时/重试）
- 群聊上下文记忆、项目解析与群绑定
- 群工作空间、代码项目平级、workspace 私聊管理
- 去重、游标、任务、分析、审批、执行、审计骨架
- 简洁/详细回复策略、审批门禁、失败降级
- 196 个单元/集成测试

未完成 / 下一步：

P0（必须先做）：

- **M0 真实飞书验证**：全量群消息权限、卡片回调时限与 payload、私聊 `open_id` 发送、历史消息时间单位。
- **真实 OpenCode 联调**：`opencode serve` + 实际仓库的审批 → 执行 → 测试 → diff 全链路；超时和取消路径已有代码，仍需真实环境验证。
- **push/PR/合并二次审批**：当前只保留配置，未实现；执行器不会 push。
- **重启恢复**：待审批卡片可恢复；正在执行的会话不会自动续跑。

P1：

- 飞书 429 退避与重试抖动；发送限流已做，接收侧退避未做。
- 预算硬停：token 预算目前是事后告警，未在批次中间硬停；每日执行次数未强制。
- 附件/图片/文件解析：OCR、文本提取和任务间引用已接入；视觉深度解析、超大文件 map-reduce 仍按需。
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

### Session 清理脚本

仓库提供 `scripts/session-cleanup.mjs`，默认只生成计划，不删除：

```bash
node scripts/session-cleanup.mjs plan \
  --directory /mnt/d/Work/source/go-projects/net-inspect/npb-transform.git \
  --min-age-minutes 60

node scripts/session-cleanup.mjs apply \
  --plan-file /tmp/opencode/atme-session-cleanup-plan.json
```

只有 `apply --yes` 才会真正删除；删除前会重新检查 session 标题、消息数、更新时间，并保护同标题最新持久 session。

### 赞助

项目免费开源。如果它帮你节省了时间，欢迎自愿赞助，不影响任何功能或授权。

- 中国大陆：支付宝收款码

![支付宝收款码](https://raw.githubusercontent.com/renyuan000/opencode-atme-proxy/main/assets/alipay.png)

> 收款码会公开展示；赞助是赠与，不是购买，不附带额外授权或支持承诺。

### 文档

- 需求：`docs/REQUIREMENTS.md`
- 记忆与证据设计：`docs/MEMORY-DESIGN.md`
- 可靠性与文件处理优化设计：`docs/OPTIMIZATION-DESIGN.md`
- 待办与决策（P0/P1/P2、参考实现、AgentSoul 评估）：`docs/BACKLOG.md`
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

- **Message type**: `@bot` classifies question / task / reminder / notification / chat before acting.
- **Direct chat**: talking to the bot in a DM gets a direct reply (owner only by default).
- **Necessity check**: `@bot` does not always reply. The bot decides `answer / need_decision / notify_owner / no_reply`.
- **Abuse protection**: per-sender rate limit, concurrency cap, and cooldown; one warning per offender, while different colleagues can still be processed concurrently.
- **Escalation**: when a decision is needed (launch, schedule, commitment, resources, risk, missing info), the bot mentions your account in the group with the question, source, and reason. It never commits on your behalf.
- **Realtime mentions**: `@bot` answers or escalates; `@me` asks you first, then replies with a quote.
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

The package is not published to the npm registry; install online from GitHub. `npm install -g opencode-atme-proxy` returns 404.

Try it without a global install:

```bash
npm exec --yes --package=github:renyuan000/opencode-atme-proxy atme-proxy -- version
```

Replace `version` with `setup`, `agents`, or `doctor`.

Global install (recommended):

```bash
npm install -g github:renyuan000/opencode-atme-proxy
```

One-shot init after install (config + agents + chat sync + doctor):

```bash
atme-proxy init
# or: npm exec --yes --package=github:renyuan000/opencode-atme-proxy atme-proxy -- init
```

`init` reuses an existing config; add `--force` to rerun the wizard.

Or into a local project:

```bash
npm install github:renyuan000/opencode-atme-proxy
npx atme-proxy version
```

Install script notes:

- The repo ships a prebuilt `dist/`; `prepare` falls back to it when `tsc` is unavailable, so a Git install does not fail on missing dev deps.
- npm 11 may still warn about `install-scripts ... allowScripts`; that is a safety notice, not an error.
- If your npm policy blocks `prepare`, clone and build:

```bash
git clone https://github.com/renyuan000/opencode-atme-proxy.git
cd opencode-atme-proxy.git
npm ci
npm run build
npm link
```

Manual build (usually unnecessary):

```bash
git clone https://github.com/renyuan000/opencode-atme-proxy.git
cd opencode-atme-proxy.git
npm ci
npm run build
npm link          # optional: put atme-proxy on PATH
```

Install the bundled agents (required for child sessions):

```bash
atme-proxy agents
# or: npx atme-proxy agents
```

This copies `atme-analyst.md`, `atme-executor.md`, `atme-reviewer.md` into `~/.config/opencode/agents/`.

### Configure (setup recommended)

```bash
atme-proxy setup
```

Two modes:

1. **QR device flow (recommended)**: calls Feishu `registerApp` to create a bot app with bot capability, scopes, events and card callback, then returns App ID / App Secret / your open_id.
2. **Manual input**: when the app already exists.

The QR flow prefills bot capability (minimal `preset: false` template), the message/chat/contact scopes, docx/wiki/sheets read scopes, `im.message.receive_v1`, bot membership events, `im.chat.updated_v1`, and `card.action.trigger`.

You still must approve the sensitive `im:message.group_msg` scope, publish the app, and add the bot to groups.

It writes `~/.config/opencode-atme-proxy/config.json` and `.env`, both mode 600.

Non-interactive:

```bash
export FEISHU_APP_ID=cli_xxx
export FEISHU_APP_SECRET=xxx
export ATME_ME_OPEN_ID=ou_xxx
export ATME_APPROVER_OPEN_IDS=ou_xxx
export ATME_FILTER_BASE_URL=https://your-endpoint/v1
export ATME_FILTER_MODEL=your-low-cost-model
export ATME_FILTER_API_KEY=xxx
atme-proxy setup --yes
```

Check:

```bash
atme-proxy doctor
```

Manual configuration (without the wizard):

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

| Field                                  | Meaning                                                    |
|----------------------------------------|------------------------------------------------------------|
| `platforms.feishu.appId`               | Feishu App ID (`cli_...`)                                  |
| `platforms.feishu.me.openId`           | Your `open_id` (`ou_...`)                                  |
| `platforms.feishu.approvers[0].openId` | Approver `open_id`, usually you                            |
| `platforms.feishu.groups[].chatId`     | Group `chat_id` (`oc_...`); use `atme-proxy chats` to list |
| `filter.baseUrl/model`                 | OpenAI-compatible low-cost model                           |
| `opencode.baseUrl`                     | `http://127.0.0.1:19876`                                   |
| `groups[].workspace`                   | Group workspace: root/projects/docs; preferred over project |
| `project.worktree`                     | Legacy main repo path; optional if auto-resolution works   |
| `repos[]`                              | Legacy repo allowlist plus test/lint commands              |

Feishu console:

1. Event subscription: long connection, add `im.message.receive_v1` and `card.action.trigger`.
2. Scopes: `im:message.group_at_msg:readonly`, `im:message.group_msg` (sensitive, admin approval), `im:message:send_as_bot`; optional `contact:user.base:readonly`.
3. Add the bot to target groups, then run `atme-proxy chats --sync` to discover chat ids and real names.
4. After restart, `chatName` in logs is resolved from `chat_id` on first use and cached.

If your console offers `im.chat.member.bot.added_v1`, the bot also auto-allowlists and DMs you on join; it is optional.

### About "configuring an LLM"

- Your existing OpenCode model is reused for replies, analysis, execution, and review. No duplicate setup; just keep `opencode serve` running.
- Batch filtering uses the OpenCode model by default (`filter.mode="opencode"`); no extra base URL or key needed.
- Set `filter.mode="external"` to use a separate low-cost model.
- If you do not want a separate filter model yet, set `filter.enabled=false`. Mentions still use the OpenCode model; periodic scanning is disabled.
- A model already configured in OpenCode does not need to be configured again here; the low-cost model in `setup` is optional.

### Run and directories

- Config defaults to `~/.config/opencode-atme-proxy/config.json`; state defaults to `~/.local/state/opencode-atme-proxy`.
- The process does not `chdir`; each OpenCode session is created with an explicit project `directory`, so sessions belong to the project, not the launch directory.
- Sessions are kept by default (`opencode.keepSessions=true`) with title prefix `atme:`; set it to `false` to delete after use.
- Project resolution: group `workspace` → legacy group `project` → explicit `project.worktree` → `project.id` → recent-session git project → most recently updated project → `repos[0].path` → `fallbackWorktree`. It never falls back to home/cwd.

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

Local simulation (no Feishu credentials needed):

```bash
npm run demo
```

Real Feishu minimal flow:

```bash
npm run probe      # print history only, no replies
npm run check      # typecheck + tests
```

See `docs/DEMO.md` for the full walkthrough.

Expected startup logs: `runtime started`, `project resolved`, `websocket ready`.

Minimum acceptance:

1. `@bot` in a group -> bot replies with a quote.
2. `@me` -> private approval card.
3. Click "reply on my behalf" -> group gets a quoted reply prefixed with `（助手代答）`.
4. Relevant non-mention message -> private digest only, no group message.

### Project context

The bot speaks as a chat assistant in Feishu and as an architect/lead engineer in OpenCode. It must work in the right repository, not in a user home directory.

Resolution order: group `workspace` → legacy group `project.primary/core` → explicit `project.worktree` → `project.id` → project with recent sessions → most recently updated git project → `repos[0].path` → `fallbackWorktree`.

In workspace mode, one group maps to one workspace; code projects are siblings under `worktrees/` and have no primary/core hierarchy. Analysis, files, docs, and execution artifacts stay in the group workspace. Owners can manage it from DM with `/工作空间`.

It ignores the `global` project (worktree `/` or home), can bind legacy chats to a resolved project (`projects.json`), and can be constrained with `project.allowlist`.

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
- Image/file parsing exists, but real-world extraction quality and large-file timeouts still need validation.
- Push/PR/merge is not implemented; the executor never pushes.
- Running executions are not resumed after a restart.

### Session architecture (current implementation v0.2)

> One anchor per conversation; groups and DMs are independent conversations. See `docs/MEMORY-DESIGN.md` and section 12 of `docs/SESSION-ARCHITECTURE-REVIEW.md`.

- One coordinator anchor per group conversation; it never runs prompts, avoiding `SessionBusyError`.
- One coordinator anchor per DM conversation; a single owner/single bot usually means one owner DM.
- One persistent summary/context session per conversation for long-term decisions.
- `reply`, `analysis`, and `review` reuse persistent workers per conversation; each worker runs one job at a time.
- `execution` remains a per-task child in its own worktree.
- There is no single global LLM session shared by all groups.
- Workers and group sessions are not swept; execution children archive after 7 days and delete after 30.
- Set `subagents.enabled=false` to fall back to one session per message.
- Bundled agent files: `.opencode/agents/atme-analyst.md`, `atme-executor.md`, `atme-reviewer.md`.

### Session and concurrency review

See `docs/SESSION-ARCHITECTURE-REVIEW.md`. Summary:

- **Adopt**: one coordinator anchor per conversation plus a persistent summary/context session; `reply` / `analysis` / `review` reuse persistent workers per conversation, while `execution` stays a per-task child.
- **Reject**: one global LLM session, per-person subagents, using subagents as pollers, storing chat history in the main session, or creating a root session per message.
- **Fast/slow paths**: classification and notification are seconds; analysis/execution/review run in children without blocking.
- **Lifecycle**: keep roots; archive children after 7 days, delete after 30; max 3 children per task, 8 global, depth=1.

### Context and memory

Three layers, so irrelevant chat is not persisted:

| Layer        | File                | Stores                                                                               | Default               |
|--------------|---------------------|--------------------------------------------------------------------------------------|-----------------------|
| Chat context | `chat-context.json` | group text (excluding pure emoji/acks), mentions, and media placeholders             | 50 msgs/chat, 7 days  |
| Key memory   | `memory.json`       | task, decision, fact, preference, deadline, outcome; proactive upsert, pinnable, TTL | 2000 entries, 90 days |
| Run log      | stderr / `logFile`  | metadata only, no message body                                                       | off                   |

Non-mention group text is persisted unless it is only emoji or a pure acknowledgement. Evidence is written by month under `replies/`, with a rebuildable `index.jsonl`; short references trigger a recent-7-day lookup. Key facts are extracted after mentions and task analysis, then injected into replies and analysis.

### Restart recovery

On startup the bot:

1. pulls recent `@me` / `@bot` messages (`recovery.lookbackSeconds`, default 6h);
2. pulls a bounded sample of non-mention group messages per group (default 50) for relevance filtering only;
3. resumes open tasks: `analyzing` re-analyzed; `candidate` remains for on-demand review; stale `awaiting_approval/needs_info` nudged; stale `executing/verifying` paused for re-approval instead of replaying code changes.

What dedup stores:

- `dedup.json`: `platform:message_id -> processedAt`; message-level only, no content.
- `cursors.json`: per-chat `lastEndTime` plus `lastMessageId / lastMessageTime` for the last message in that window.
- Polling starts at `cursor - overlap`; the cursor advances only after the whole batch (including mentions) succeeds.
- `outbound.json`: outbound idempotency keys to prevent duplicate sends.

No duplicate work: dedup is written only after a successful reply/notification; failed sends retry; outbound messages carry a stable `uuid`; completed/rejected/canceled tasks are never re-run.

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

### Sponsorship

The project is free and open source. If it saves you time, voluntary support is welcome and does not affect features or licensing.

- Mainland China: Alipay QR code

![Alipay QR code](https://raw.githubusercontent.com/renyuan000/opencode-atme-proxy/main/assets/alipay.png)

> The QR code is public; sponsorship is a gift, not a purchase, and carries no extra license or support commitment.

### Docs

- Requirements: `docs/REQUIREMENTS.md`
- Memory and evidence design: `docs/MEMORY-DESIGN.md`
- Reliability and file-processing design: `docs/OPTIMIZATION-DESIGN.md`
- Backlog and decisions (P0/P1/P2, reference review, AgentSoul): `docs/BACKLOG.md`
- Config example: `config.example.json`
- Env example: `.env.example`
