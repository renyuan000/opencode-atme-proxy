# 架构与实现审核

| 项目 | 内容 |
|---|---|
| 日期 | 2026-11-23 |
| 范围 | conversation/session、群/私聊上下文、媒体关联、任务/执行、审批、飞书接入、多 channel 可移植性 |
| 基线 | `e23c06d`，测试 149/149，服务 active |
| 用途 | 记录当前判断、主要缺口和后续优化路线，供实现和多平台接入参考 |

> 本文是审核记录，不代表所有条目已实现。实现状态以代码和测试为准。

---

## 1. 总体结论

```text
飞书单应用 + 单 owner：可长期试用
第二个结构化 IM：需要适配，但核心可复用一部分
微信/企业微信：当前还不够友好
多飞书应用/多账号/多 owner：架构未完成
```

当前不是“所有 APP 群/私聊都能直接接”的状态，而是**飞书优先、核心部分开始平台化**。

---

## 2. 架构分层评分

| 维度 | 当前状态 | 评分 | 主要问题 |
|---|---|---:|---|
| 消息模型 | `IncomingMessage`、`ChatRef` 基本平台无关 | 8/10 | 附件/引用/线程语义靠 adapter 归一化 |
| Channel Adapter | `PlatformAdapter` 已有 | 6/10 | 核心仍大量直接读 Feishu 配置 |
| Conversation/Session | conversation key + epoch 已落地 | 8/10 | 群/私聊物理存储仍以 chatId 为主 |
| 群/私聊上下文 | 目录隔离 + conversation key | 7/10 | 跨应用/多账号隔离不完整 |
| 群画像/方向 | 产品、职责、术语、owner 方向/关键词 | 7/10 | 关键词已降为强信号，但真实效果未验证 |
| 媒体理解 | @ 图片视觉附件 + 扫描 OCR | 6/10 | 前文媒体只接入回复路径，任务路径未完整 |
| 任务/审批 | 任务状态、审批、审计 | 7/10 | 审批依赖飞书卡片，缺文本降级 |
| 工作空间/执行 | 多项目、worktree、test/lint | 7/10 | 提交/合并/PR/清理未闭环 |
| 模型/provider | OpenCode 默认模型 | 4/10 | 代理未强制模型，视觉能力不确定 |
| 多 channel/多账号 | 只有 session 层有 account 概念 | 3/10 | config/owner/storage 仍 Feishu 中心 |
| 测试/验证 | 149 个单元/集成测试 | 6/10 | 缺真实 Feishu/OpenCode E2E、第二 adapter 契约测试 |
| 代码可维护性 | 功能完整但集中 | 4/10 | runtime 约 2900 行，reply-service 约 1100 行，耦合较重 |

---

## 3. 按平台友好度

| 平台/场景 | 当前友好度 | 说明 |
|---|---:|---|
| 飞书群聊 | 8/10 | 事件、历史、@、文件、卡片、转发都较完整 |
| 飞书 owner 私聊 | 8/10 | DM context、长期 session 已做 |
| 第二个结构化 IM | 5/10 | 需要 adapter + 配置下沉 |
| 微信个人号 | 2/10 | 无稳定官方 Bot API，不建议作为正式依赖 |
| 企业微信/公众号 | 4/10 | 需要文本审批、历史/卡片/@ 能力降级 |
| 多飞书应用 | 3/10 | session 有 account，但 config/owner/state 仍按 Feishu/chatId |
| 多 owner | 3/10 | owner 仍是单个 Feishu openId |
| 多群 + 多私聊 | 6/10 | 群/私聊分离已做，跨应用隔离不足 |

---

## 4. 已经具备的能力

| 能力 | 状态 |
|---|---|
| 群/私聊 conversation 分离 | 已有 |
| 一个 conversation 一个锚点 | 已有 |
| 无全局 LLM 主 session | 已有 |
| session key 带 conversation + epoch | 已有 |
| 群长期上下文 | 已有 |
| 私聊 `dm-context.json` | 已有 |
| 群画像/术语/owner 方向/关键词 | 已有 |
| 关键词作为强信号而非唯一门槛 | 已有 |
| 前置媒体候选 + 本地 OCR + LLM 关联 | 已有 |
| 工作空间/多项目/worktree/test-lint | 已有 |
| 群消息转发到 owner | 已有 |
| 149 测试通过 | 已有 |

---

## 5. 主要问题

### P0：多 APP 友好的阻断项

| 问题 | 影响 |
|---|---|
| `platforms.feishu` 深度写入核心 | 接第二个渠道要改很多核心代码 |
| owner 只有一个 Feishu openId | 微信/企业微信无法统一身份 |
| 群状态/任务/owner-target 仍主要按 chatId | 多应用/多账号可能撞目录或状态 |
| 审批依赖卡片 | 无卡片渠道无法完成审批闭环 |

### P1：飞书深化和上下文闭环

| 问题 | 影响 |
|---|---|
| 媒体簇只覆盖回复路径 | 任务分析仍可能丢前置图片 |
| 非 @ 图片/文件没有审批门禁 | 可能自动深度解析或建任务 |
| 模型/provider 未显式绑定 | 图片是否真正进入视觉模型不确定 |
| 无 channel capability fallback | 无 history/reply/thread/card 的平台行为不完整 |
| 分析/摘要超时 | 日志已出现 `summary timed out` / analysis timeout |

### P2：质量和运维

| 问题 | 影响 |
|---|---|
| runtime/reply-service 过大 | 改动容易互相影响 |
| 无真实 E2E | 功能“代码上通”，效果未证明 |
| 无语义检索/统一 token 预算 | 长期上下文仍可能找不到或挤爆 |
| 旧 session/媒体簇缺少完整归档策略 | 长期运行后状态可能膨胀 |

---

## 6. 存储现状说明

当前是“物理上按群/私聊分目录”，但不是“目录 key 完全 conversation 化”。

```text
/root/.local/state/opencode-atme-proxy/groups/
├── 产品-资产测绘__oc_b24...
│   ├── chat-context.json
│   ├── group-context.json
│   ├── tasks/
│   └── ...
├── 产品-流分装置__oc_aafe...
└── 私聊__oc_b014...
    ├── chat-context.json
    ├── dm-context.json
    └── ...
```

现状：

- 物理目录：按 `chatId` 分群/私聊
- `chat-context` / `group-context` 内部 key：已 conversation 化
- `session` key：已 conversation + epoch
- `group.json`：记录 conversationId
- `tasks/`、`owner-target`、群状态目录：仍主要按 chatId/owner
- `group-state.ts` 仍硬编码 `groupKey: feishu:<chatId>`
- 私聊识别仍依赖 chatId 前缀和历史命名

结论：

```text
单飞书应用：够用
多应用/微信/多账号：逻辑隔离不完整
```

---

## 7. 目标架构

```text
ChannelAccount
  ├─ channel type
  ├─ accountId
  ├─ capabilities
  └─ owner binding

Conversation
  ├─ conversationId
  ├─ kind: group | dm
  ├─ persistent context
  ├─ workspace binding
  └─ session bindings

Principal
  ├─ Feishu identity
  ├─ WeChat identity
  └─ WeCom identity

Agent Kernel
  ├─ context builder
  ├─ task engine
  ├─ session orchestrator
  ├─ approval
  └─ audit

Adapter / Provider
  ├─ Feishu
  ├─ WeChat/WeCom
  └─ future channels
```

核心规则：

- 核心不直接读 `config.platforms.feishu`
- 核心只依赖 `ChannelAccount`、`Conversation`、`Principal`、`CapabilitySet`
- 群/私聊存储统一使用 conversationId
- 飞书文档/卡片/转发下沉到 Feishu provider
- 无卡片平台支持文本审批
- 无历史/无线程/无 mention 结构化时使用 capability fallback

---

## 8. 优化 Plan

### Phase 0：平台契约

| 任务 | 验收标准 |
|---|---|
| 引入 `ChannelAccount` 配置 | 支持多个 channel/account，不再核心读取 `platforms.feishu` |
| 引入 `Principal` | 同一个 owner 可关联 Feishu/WeChat/WeCom 身份 |
| 统一 `ConversationRef` | adapter 产生 conversation key，核心不再拼 `platform:chatId` |
| Adapter 契约测试 | 至少 Feishu + 一个 FakeChannel 跑同一套核心测试 |

### Phase 1：存储与审批解耦

| 任务 | 验收标准 |
|---|---|
| group-state/tasks/owner-target 物理 key conversation 化 | 多 app 同名 chatId 不冲突，旧数据可回退 |
| 文本审批降级 | 无卡片平台可通过 `/批准 <id>`、`/拒绝 <id>` 完成审批 |
| capability fallback | 无 reply/history/thread/cards 时自动降级，不崩溃 |
| Feishu 文档/卡片/转发下沉 | 核心不出现 `/docx/`、`/wiki/` 等 Feishu 规则 |

### Phase 2：上下文与媒体闭环

| 任务 | 验收标准 |
|---|---|
| 媒体簇接入任务分析 | 前面图片 + 后面 @我任务，图片进入任务分析 |
| 非 @ 媒体审批门禁 | 先 OCR/相关性提示，owner 批准后才深度解析/建任务 |
| 统一上下文预算 | prompt token 超限按优先级裁剪 |
| 语义检索 | 长历史问题可回查决策/术语/证据 |

### Phase 3：执行交付闭环

| 任务 | 验收标准 |
|---|---|
| 多项目执行提交/合并/PR | 每个项目 worktree 有明确结果和审批 |
| worktree TTL 清理 | 完成/失败后可清理，有审计 |
| 执行超时/取消/恢复 | 重启、失败、取消都有确定状态 |
| 真实 E2E | 群/私聊 → 分析 → 审批 → 修改 → test/lint → diff |

### Phase 4：多平台验证

| 任务 | 验收标准 |
|---|---|
| 企业微信或 Slack adapter | 群/私聊、附件、历史、审批至少一个跑通 |
| 多 owner | 每个 owner 独立 DM context 和审批 |
| 多应用同 chatId | 状态、session、任务、owner target 不串 |

---

## 9. 推荐优先级

```text
不要先做微信 adapter。
先做：
1. ChannelAccount
2. Principal
3. conversation storage
4. capability fallback / text approval
5. media cluster 任务路径 + 非 @ 审批门禁
6. 真实 E2E
```

## 10. 最终判断

当前设计方向是对的：

```text
conversation 为事实源
session 为执行租约
群/私聊独立
关键词只是信号
媒体关联走候选 + LLM
```

但**多 APP 友好度还不够**，核心仍然带有较多 Feishu 假设。  
现在适合继续深化飞书真实效果和存储解耦，不适合直接宣称“已支持各种 APP 机器人”。
