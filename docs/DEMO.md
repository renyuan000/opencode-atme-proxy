# 最简验证流程（本地模拟，不需要飞书凭据）

目标：在不接真实飞书、不调用外部模型、不改真实仓库的前提下，验证当前实现的核心行为。

## 1. 准备

```bash
cd /home/renyuan/opencode-atme-proxy.git
npm install
npm run demo
```

不需要 `.env`、不需要 `opencode serve`、不需要飞书应用。

## 2. 演示会验证什么

| 步骤 | 验证点               | 期望                               |
|------|----------------------|------------------------------------|
| 0    | 助手角色             | 研发任务助手，只处理工作相关消息    |
| 1    | @机器人 简洁回复     | 回复短，≤60 字（演示配置）            |
| 2    | @机器人 要求详细     | 检测到「详细」后展开                 |
| 3    | @机器人 寒暄         | 不回复，避免刷屏                    |
| 4    | @机器人 需要你决策   | 群里 @ 你的主账号，附问题/来源/原因 |
| 5    | 多个同事并发 @机器人 | 各自处理，互不阻塞                  |
| 6    | 同一人刷屏           | 只警告一次，后续静默丢弃            |
| 7    | @我                  | 不直接回群，私聊审批卡，含拟回复     |
| 8    | 批准代答             | 群内引用回复，带「（助手代答）」        |
| 9    | 非 @ 批量筛选        | 只私聊汇总「仅知会」，群里无动静      |
| 10   | 指标                 | 并发/限流/无失败                   |

## 3. 真实飞书最小流程

前置：

- 飞书自建应用，开启机器人能力
- 长连接事件：`im.message.receive_v1`、`card.action.trigger`
- 权限：`im:message.group_at_msg:readonly`、`im:message.group_msg`（需管理员）、`im:message:send_as_bot`
- 机器人已入群
- `opencode serve --port 19876` 已启动
- 一个 OpenAI 兼容的低成本模型

配置：

```bash
atme-proxy setup
atme-proxy doctor
```

或手动：

```bash
mkdir -p ~/.config/opencode-atme-proxy
cp config.example.json ~/.config/opencode-atme-proxy/config.json
chmod 600 ~/.config/opencode-atme-proxy/config.json
cp .env.example .env
```

编辑 `.env`：

```text
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
ATME_ME_OPEN_ID=ou_xxx
ATME_APPROVER_OPEN_IDS=ou_xxx
# 或者不填 open_id，改用私聊一次性绑定码：
# ATME_CLAIM_CODE=随机字符串

ATME_FILTER_BASE_URL=https://your-endpoint/v1
ATME_FILTER_API_KEY=xxx
ATME_FILTER_MODEL=your-low-cost-model
ATME_OPENCODE_URL=http://127.0.0.1:19876
```

编辑 `config.json`：

- `platforms.feishu.groups[].chatId` 改成目标群
- `project.worktree` 改成主项目绝对路径
- `repos[]` 可选：执行开发时用

启动：

```bash
npm run probe   # 先只拉历史消息，确认权限与群 ID
npm start
```

真实验收：

1. 群里 @机器人：「支付灰度怎么配？」
   - 期望：机器人引用回复，默认简短。
2. 群里 @机器人：「请详细说明支付灰度步骤」
   - 期望：回复展开。
3. 群里 @机器人：「谢谢」
   - 期望：机器人不回复。
4. 群里 @机器人：「支付灰度今天能上线吗？」
   - 期望：机器人在群里 @ 你，并说明需要你确认。
5. 群里 @我：「支付灰度什么时候上？」
   - 期望：私聊收到审批卡，群内无回复。
6. 私聊点「代答」
   - 期望：群里出现带「（助手代答）」的引用回复。
7. 群里发一条非 @ 的相关消息
   - 期望：私聊收到汇总，群里无回复。
8. 群里发一条闲聊
   - 期望：无推送。

### 3.0 会话结构验证

真实运行时，在项目目录执行：

```bash
opencode session list
```

期望：

- 每个群只有一个 root：`atme:chat:<chatId>`。
- 子会话（reply/analysis/execution/review）不显示，因为它们 `parentID` 指向 root。
- 查看 `~/.local/state/opencode-atme-proxy/sessions.json` 可看到 `kind: coordinator`、`kind: group`、`kind: worker` 和 `kind: child`。

如果看到每个消息一个 root，说明 `subagents.enabled=false` 或 child 创建失败，查日志 `createChildSession`。

### 3.1 重启恢复验证

本演示不重启进程；手动验证真实重启：

1. `npm start`，在群里 @机器人 一条，等它回复。
2. `Ctrl+C` 停掉。
3. 再 `npm start`。
4. 期望：同一条消息不会被重复回复；未完成审批会收到提醒；列表里不会出现重复任务。

状态目录：

```bash
ls -la ~/.local/state/opencode-atme-proxy
cat ~/.local/state/opencode-atme-proxy/dedup.json
cat ~/.local/state/opencode-atme-proxy/outbound.json
```

### 3.2 上下文与记忆检查

```bash
cat ~/.local/state/opencode-atme-proxy/chat-context.json
cat ~/.local/state/opencode-atme-proxy/memory.json
```

期望：

- `chat-context.json` 只出现 @消息和被判定相关的消息，不出现闲聊。
- `memory.json` 出现任务/决策等条目，带来源 messageId。
- 日志里有 `messageId/chatId`，但没有正文。

## 4. 出问题看哪里

```bash
# 日志（默认 stderr；配置 logFile 时也写文件）
npm start

# 状态目录
ls -la ~/.local/state/opencode-atme-proxy
```

常见：

| 现象                           | 原因                                    |
|--------------------------------|-----------------------------------------|
| `Feishu app secret is missing` | `.env` 未加载或变量名不对               |
| `no enabled groups`            | `groups` 为空或 `enabled=false`         |
| 收不到非 @ 消息                | `im:message.group_msg` 未审批或事件未配 |
| 卡片无响应                     | `card.action.trigger` 未订阅            |
| 私聊发不出                     | 机器人未与用户建立会话 / open_id 不对   |
| `no active project resolved`   | 配置 `project.worktree`                 |

## 5. 当前演示的边界

- 演示用假适配器、假 OpenCode、假模型；不验证真实飞书 API。
- 真实飞书的权限、卡片回调、私聊发送仍需 M0 实测（见 `docs/BACKLOG.md` P0-1）。
- 演示不执行真实代码修改；执行链路需真实仓库联调（P0-2）。
