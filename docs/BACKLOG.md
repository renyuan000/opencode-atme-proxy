# opencode-atme-proxy 待办与决策记录

| 项目 | 内容                                                               |
|------|--------------------------------------------------------------------|
| 版本 | v0.2                                                               |
| 更新 | 2026-11-24                                                         |
| 用途 | 记录未完成事项、P0/P1/P2 优先级、参考实现评估与决策，避免口头约定丢失 |

> 本文只记录待办与决策，不代表已实现。实现状态以代码和测试为准。
>
> 2026-11-20 进展：群工作空间、多项目 worktree 执行、项目级 test/lint、群术语/sessionEpoch 已落地；`P1-3` 附件/图片解析已实现，`P1-5` worktree 清理仍未接入。真实飞书/OpenCode 闭环与合并/推送仍未完成。

---

## 1. P0（阻塞上线 / 必须先做）

| ID   | 事项                                     | 为什么是 P0                                                           | 验收标准                                                                                                                                                                                                                                                         | 依赖             | 状态                 |
|------|------------------------------------------|-----------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------|----------------------|
| P0-1 | 飞书 M0 能力验证                         | 全量群消息、卡片回调、私聊发送都是未验证假设，直接决定架构是否成立       | 输出 `docs/M0-FINDINGS.md`：①`im.message.receive_v1` + `im:message.group_msg` 能否收到非 @ 全量群消息；②历史消息时间单位/边界/分页；③卡片回调 payload/时限；④私聊 `receive_id_type=open_id` 限制；⑤机器人自身消息是否回推；⑥429 结构；⑦私聊 claim code 所需事件与 scope | 真实飞书应用与群 | 未开始               |
| P0-2 | OpenCode 真实联调                        | 目前执行链路是骨架，未在真实仓库跑通「审批 → 执行 → 测试 → diff」        | 真实仓库完成：@bot 回答、@me 请示、批准后执行、lint/test 门禁、diff 报告；未批准零执行；超时/取消可用                                                                                                                                                                   | P0-1、真实仓库    | 未开始               |
| P0-3 | push/PR/合并二次审批                     | 配置已保留但未实现；没有它不能安全交付代码                             | 默认不 push；开启后 push/PR 需二次审批；合并需再次审批；审计记录 commit/PR；禁止 force push 与保护分支直推                                                                                                                                                           | P0-2             | 未开始               |
| P0-4 | 执行恢复 / 超时 / 取消                   | 已实现启动补拉、去重后置、未完成任务续作、中断不重放；仍需真实环境验证    | 重启后执行中任务标记中断，不自动重放；待审批卡片可恢复；取消能终止会话并保留 worktree/日志；不重复发消息                                                                                                                                                             | P0-1、P0-2        | 部分完成（待真实验证） |
| P0-5 | 安装与诊断体验                           | 已提供 setup/init/doctor/status/stop；仍需在真实环境验证权限与项目目录 | 提供 `atme-proxy setup`（扫码/手动）、`init`（setup + agents + chats --sync + doctor）、`doctor`、`status`、`stop`；`--daemon` 与 `logs` 仍待实现；按 README 可从零跑通                                                                                                    | 无               | 部分实现（待真实验证） |
| P0-6 | 机器人人格与角色（作用域隔离）             | 飞书里是助手、OpenCode 里是架构/研发角色；不能污染用户自己的普通会话    | `persona` 配置（身份/职责/语气/边界/项目上下文）只注入飞书任务与回复会话；普通 OpenCode 会话不受影响；可选只读导入 AgentSoul 文件；有测试断言不外溢                                                                                                                   | P0-2             | 未开始               |
| P0-7 | 会话架构重构（v0.2 coordinator + 3 child） | 每消息建 root 会无限增长；需 coordinator 复用、确定性 child、归档策略    | 已实现 coordinator 锚点、reply/analysis/execution/review child、sessions.json、7/30 天清理、reviewer；待真实验证                                                                                                                                                      | P0-2             | 已实现（待真实验证）   |

---

## 2. P1（首期应有，可稍后）

| ID    | 事项                    | 验收标准                                                         |
|-------|-------------------------|------------------------------------------------------------------|
| P1-1  | 飞书 429 退避与重试抖动 | 接收/发送均区分可重试错误；指数退避 + 抖动；不刷屏                 |
| P1-2  | 硬预算                  | 单轮 token、每日执行次数在批次中间硬停，不只事后告警               |
| P1-3  | 附件解析                | 图片/文件/语音按配置下载或 OCR；默认不出网；有大小/类型限制        |
| P1-4  | 群内结果回写            | 默认关闭；按任务开启；只回写批准过的任务；限频                      |
| P1-5  | worktree 清理           | 完成后按 TTL 清理；清理前确认；审计记录                            |
| P1-6  | 多审批人 / 超时重发     | 支持多个 approver；超时后可一键重新发起                           |
| P1-7  | 插件模式验证            | 在真实 OpenCode 1.19.x 加载本地/包路径；验证 dispose、锁、重启      |
| P1-8  | 集成测试与 CI           | Mock 飞书服务 + 沙箱仓库；CI 跑 typecheck/test/build              |
| P1-9  | 部署与日志轮转          | systemd/pm2 单元；日志按天/大小轮转；备份恢复脚本                  |
| P1-10 | 任务跨消息合并          | 同一任务多轮讨论合并为一个任务；避免重复建单                      |
| P1-11 | 限流参数调优与指标      | 按真实群流量调整 perSenderPerMinute/cooldown；输出被限流/丢弃指标 |

---

## 3. P2（后续增强）

| ID   | 事项                                                      |
|------|-----------------------------------------------------------|
| P2-1 | 第二个平台适配器（Slack / Telegram / Discord / Teams 选一） |
| P2-2 | 任务优先级与排序（截止时间/影响面/提出人）                  |
| P2-3 | 上下文摘要（当前保留最近 N 条原文）                         |
| P2-4 | 无卡片平台的 Web 审批降级（签名链接）                       |
| P2-5 | 多账号 / 多配置 profile 管理                              |
| P2-6 | 钉钉 / 企业微信 / WhatsApp 适配与限制说明                 |

---

## 4. 参考实现评估：opencode-feishu（只读参考，不复制架构）

参考路径：`/home/renyuan/opencode-feishu.git`。仅作为 API 用法与交互体验参考，不沿用其事件处理器、会话管理和卡片架构。

| 能力                                  | 参考位置                                                                                                                                                                        | 决策            | 说明                                                                              |
|---------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----------------|-----------------------------------------------------------------------------------|
| 扫码创建应用（device flow）             | `src/setup/device-flow.ts:24-42`（`accounts.feishu.cn/oauth/v1/app/registration`，`archetype=PersonalAgent`，`auth_method=client_secret`，`request_user_info=open_id tenant_brand`） | **采纳到 P0-5** | 只解决凭证获取；敏感 scope（如 `im:message.group_msg`）仍需管理员审批，不能承诺全自动 |
| 配置向导                              | `src/setup/wizard.ts`                                                                                                                                                           | **采纳到 P0-5** | 扫码失败回退手动；保留环境变量提供 secret 的做法                                   |
| 预检 `doctor`                         | `src/setup/preflight.ts`                                                                                                                                                        | **采纳到 P0-5** | 检查配置、凭据、bot open_id、OpenCode、权限、白名单；我们会增加项目解析检查             |
| 守护进程 / PID / 心跳 / status / logs | `src/core/daemon.ts:13-15`、`src/cli.ts:46,90,157,182`                                                                                                                           | **采纳到 P0-5** | 提供 `--daemon`、`status`、`logs`、`stop`；保留我们自己的 `instance.lock`             |
| profile 多配置                        | `src/cli.ts:303-408`                                                                                                                                                            | 暂缓 P2-5       | 首期单用户单配置，多账号后续做                                                     |
| workdir 持久化                        | `src/core/workdir-manager.ts`                                                                                                                                                   | 不直接采纳      | 我们已有 `project-resolver` + `projects.json`，按群绑定项目更合适                  |
| 每会话 busy 时拒绝新消息              | `src/core/message-handler.ts:180-190`                                                                                                                                           | 不采纳          | 我们要求同群 @ 并发，busy 拒绝会违背需求                                           |
| 仅 @ 机器人才处理                     | `src/core/message-handler.ts:145-162`                                                                                                                                           | 不采纳          | 我们还需要非 @ 全量筛选                                                           |
| 卡片流式渲染架构                      | `src/feishu/card.ts`                                                                                                                                                            | 不照搬          | 我们只做审批/汇总卡，按自己的状态机渲染                                            |

---

## 5. AgentSoul 评估（人格/角色插件）

已检查 npm 包：`@neomei/agentsoul@0.1.14`（`npm view` 与包内源码）。

### 5.1 它是什么

- 独立的 **OpenCode 全局插件**，与飞书无耦合。
- 人格文件：`~/.agentsoul/soul/IDENTITY.md`、`SOUL.md`、`USER.md`。
- 注入方式：插件 hook `experimental.chat.system.transform`，在每次 LLM 调用前把人格文本追加到 system prompt。
- 记忆：`chat.message` hook 把用户消息写入 `~/.agentsoul/memory.db`（SQLite；环境不支持时回退 JSON）。
- 安装：`agentsoul setup` 会自动把 `@neomei/agentsoul` 注册进 `~/.config/opencode/opencode.json`。

### 5.2 是否适合本项目

**不建议直接依赖**，原因：

1. **作用域过大**：它影响所有 OpenCode 会话，包括你本人日常开发会话，不只是飞书机器人。
2. **记忆混流**：飞书群聊内容会进入全局 `memory.db`，与个人会话混在一起，隐私边界不清。
3. **角色冲突**：模板是“温暖、有情绪、主动表达”的伴侣型人格；本项目需要“架构师 + 研发负责人 + 审批纪律 + 简洁回复”，直接套用会冲突。
4. **依赖与复杂度**：需要 SQLite/原生模块回退逻辑；我们首期用 JSON 状态更轻。
5. **不可审计**：全局注入难以按任务/群追踪，出了偏差不好定位。

### 5.3 建议方案（已记为 P0-6）

- 在本项目内实现 `persona` 配置：`name`、`role`、`tone`、`boundaries`、`projectContext`、`responseStyle`。
- 只注入到飞书相关会话（回复、任务分析、执行），普通 OpenCode 会话不受影响。
- 可选 `persona.source: "agentsoul"`：只读导入 `~/.agentsoul/soul/*.md` 作为补充，但不安装、不写全局配置。
- 任务分析与执行仍保留强约束：不可被 persona 覆盖审批门禁、工具白名单、仓库白名单。
- 验收：测试断言 persona 不会出现在非飞书会话；关闭后完全无注入。

### 5.4 如果仍想用 AgentSoul

可以，但请明确它是全局生效：

```bash
npx @neomei/agentsoul setup
```

风险：会影响你所有 OpenCode 会话，并把消息写入 `~/.agentsoul/memory.db`。本项目不会默认安装它。

---

## 6. 当前已实现（对照）

- 飞书适配器：WS 事件、历史消息、发送/回复、审批卡
- 并发 @：同群 4 并发、跨群并行、有界队列、超时/重试、发送限流
- 项目解析与群绑定、群聊上下文
- 去重、游标、任务、分析、审批、执行、审计骨架
- 群摘要、全量群文本证据、持久 reply/analysis/review worker
- 回复必要性、回执优先、引用解析、私聊改稿/撤销、卡片回复管理
- 简洁/详细回复、审批门禁、失败降级
- 181 个测试通过

## 6.1 本轮 P0 权限与评审门禁（2026-11-25）

已完成：

- `group.project.primary` 兼容 `string | string[]`，内部统一为数组。
- 可写项目 = `primary + core`；只读项目 = `reference + secondary`。
- analysis / analysis-check / execution prompt 注入可写与只读项目。
- 显式项目执行使用任务 worktree，不直接修改源 `dev`。
- 分析完整性检查：`actionability=task` 且缺少范围/计划/文件/验收时进入 `needs_info`。
- execution review 输出结构化结论；`结论：需修改` 时任务进入 `needs_info`，不再直接标记完成。
- 审批卡补充群名、原消息链接、计划文件、执行计划和项目范围。

待验证：

- OpenCode 全局 `permission` 与 atme session 权限的优先级。
- 多可写项目 worktree 的真实执行、测试和 diff 汇总。

## 7. 建议顺序

1. **P0-1 M0 验证**：先确认飞书能力，避免在错误假设上继续开发。
2. **P0-5 setup/doctor**：已实现 setup/doctor/status/logs/stop；待真实环境验证。
3. **P0-2 真实联调**：打通审批 → 执行 → 测试 → diff。
4. **P0-3 / P0-4**：安全交付与恢复。
5. **P0-6 persona**：在联调稳定后接入，避免人格干扰排障。

---

## 8. 下一阶段计划（2026-11-24）

### 8.1 先修体验与回归（1–2 天）

> 2026-11-24 进展：N-1/N-2/N-3/N-5 已验证，N-4 文档同步随本次提交；N-6 OCR 本地增强已实现。

| ID | 类型 | 事项 | 验收标准 |
|---|---|---|---|
| N-1 | bug | 候选任务发送人显示“成员” | 解析顺序 `task.requester.displayName → fetchUserName → fetchMessage.sender.displayName → 成员`，候选卡显示真实姓名 |
| N-2 | test | 候选卡群名/发送人/重复提醒回归 | 新候选卡标题含真实群名和姓名；创建后重启不立刻重复发“未完成任务提醒” |
| N-3 | verify | 群名卡片实卡验证 | 真实飞书截图确认：群消息分析标题 `群消息分析 · 群名`、未完成提醒右侧群名、候选卡标题 `候选任务 · 群名` 均正常；空白占位列不显示异常 |
| N-4 | docs | 提交本轮设计文档更新 | `FILE-INGESTION-DESIGN` 与 `OPTIMIZATION-DESIGN` 已同步，测试/基线一致 |
| N-5 | feat | 消息级深链 | 优先 `message_app_link`，缺失用 `openChatId + position`；卡片显示“打开原消息/查看原消息”，无链接回退群链接 |
| N-6 | feat | OCR 本地增强 | RapidOCR 优先、Tesseract 回退；采样指纹 + dHash 近似去重；在线 OCR 不默认启用 |
| N-7 | feat | 回复式任务补充 | owner 回复审批卡/任务来源消息自动追加；待审批重新分析，执行中只记录 |

### 8.2 文件摄取 P0（3–5 天）

> 2026-11-24 进展：F-1 基础类型与结构化提取已实现；F-2 的 maxBytes/maxChars/timeout 基础选项已实现，服务尚未统一接入；Excel .xlsx/.xls 已覆盖测试。

| ID | 事项 | 验收标准 |
|---|---|---|
| F-1 | `FileEnvelope` + `ExtractedDocument` | 文件统一返回 `{conversationId,sha256,mime,size,totalPages,pagesProcessed,chars,truncated,readRanges,localPath}`；旧行为不变，新增单测 |
| F-2 | 原始资源门禁 | 原始字节、PDF 页/页像素、图片像素、提取超时、并发上限可配置；超限返回明确 marker |
| F-3 | PDF 页级/版面 | `pdfinfo` 页数、`pdftotext -f -l`、表格页 `-layout`、扫描页图/OCR 兜底；50 页 PDF 只读目标页 |
| F-4 | 选段算法 + `readRanges` | 本地目录 → 关键词/BM25 粗排 → Top 1–3 节 → 阈值兜底 → 补读；记录已读/未读范围 |
| F-5 | 工作区附件 + hash 缓存 | 群 `files/<sha256>`、任务只读 `attachments/<sha256>`；缓存键 `conversationId + sha256` |
| F-6 | 浅层/深层拆分 | 非 @ 文件只浅层索引；`@机器人`、`/分析`、任务分析或 owner 批准后深度读取 |

### 8.3 文件摄取 P1（紧随 P0）

| ID | 事项 | 验收标准 |
|---|---|---|
| F-7 | 在线文档内容缓存 | URL/飞书文档按 `conversationId + URL + contentHash/etag` 失效；无权限明确提示 |
| F-8 | 执行阶段附件 manifest | 执行 prompt 复用 `attachmentManifest`、摘要、`readRanges`；执行阶段不重复 OCR |
| F-9 | Prompt 注入围栏 | 文件正文统一 `[UNTRUSTED_FILE_CONTENT]`；文件内指令不触发工具调用 |
| F-10 | 清理/配额 | 原始附件、提取文本、页图、任务副本分别设置 TTL/配额；任务结束清理派生文件 |

### 8.4 暂不做

- persona/AgentSoul
- push/PR/合并二次审批
- 多平台 adapter（微信/企业微信/Slack）
- Web 审批降级

### 8.5 推荐顺序

1. `N-1` → `N-2` → `N-3`：先把当前可见体验问题收口。
2. `F-1` → `F-2` → `F-6`：先把文件管道的类型、门禁、浅/深层打稳。
3. `F-3` → `F-4` → `F-5`：再做 PDF 页级、选段和工作区附件。
4. `F-7` → `F-10`：在线文档、执行复用、围栏、清理。
5. 最后做真实飞书 + 多页 PDF + 视觉模型 E2E。
