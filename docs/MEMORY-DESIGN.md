# 记忆与证据设计

| 项目 | 内容 |
|------|------|
| 版本 | v1.0（已确认） |
| 日期 | 2026-11-16 |
| 状态 | 设计定稿；实现按本文执行 |
| 关联 | `docs/REQUIREMENTS.md`、`docs/SESSION-ARCHITECTURE-REVIEW.md` |

> 目标：与我和我的项目高度相关的群消息、回复，长期留存并可随时召回；低相关消息不长期占用空间；记忆提炼必须经过评审，重要结论要由我确认。

---

## 1. 结论

- **证据按群 + 日期存 720 天**，保留原文和 message_id。
- **记忆只留高价值结论**：决策、截止、承诺、事实、结论。
- **高影响记忆必须我确认后才置顶**：决策 / 截止 / 承诺。
- **提炼与评审分两步**，避免模型自证。
- **OpenCode session 不是长期记忆**，7 天归档 / 30 天删除，不影响证据与记忆。
- 不做五层目录、不做复杂信任模型、不做大批指标；保持最小可用。

---

## 2. 为什么不能依赖 OpenCode session

事实（本机实测）：

- `opencode.db` 约 1.1 GB，67 个 session、2.1 万条 message、8 万条 part。
- session 删除会永久移除消息和历史。
- 归档只是 `time_archived` 标记，不是长期归档策略。
- session 会被 compact，细节有损。
- session 没有按群/日期的检索结构。

因此：

| 层 | 作用 | 是否长期 |
|----|------|----------|
| OpenCode session | 对话载体、调试 | 否，7/30 天清理 |
| 证据文件 | 召回、审计、复盘 | 是，720 天 |
| 记忆文件 | 跨会话召回 | 是，pinned 永久 |
| 任务档案 | 分析/审批/执行/评审 | 是 |

`compacting` 只是 session 内的滚动窗口，不能替代长期记忆。正确关系：

```text
长期记忆（文件）→ 注入上下文 → session 对话 → compacting 滚动
```

---

## 3. 目录结构

```text
<stateDir>/
  memory/
    <chatId>/
      2026-11-16.jsonl          当日记忆
      index.json                该群 pinned 记录与水位
  replies/
    <chatId>/
      2026-11-16.jsonl          当日相关原文与回复（720 天）
  tasks/
    <taskId>.json
  analyses/<taskId>/<version>.json
  approvals/<taskId>.json
  executions/<taskId>.json
  reviews/<taskId>.json
  chat-context.json             最近 30 条 / 7 天，只给 prompt
  dedup.json                    低相关消息只留 message_id
  audit.jsonl                   只记动作与 ID，不记正文
```

规则：

- 按 `chatId` 分目录，按日期分文件，避免单文件膨胀。
- 回溯时按日期直接定位，不扫全量。
- 权限 600/700。
- 删除按 `chatId` / `taskId` / 日期，按文件操作。

---

## 4. 数据模型

### 4.1 证据记录（replies）

```json
{
  "chatId": "oc_...",
  "date": "2026-11-16",
  "messageId": "om_in_...",
  "replyMessageId": "om_out_...",
  "kind": "bot_mention | proxy_reply | direct | owner_notify | review",
  "text": "回复原文",
  "model": "opencode",
  "reason": "必要性判断理由",
  "taskId": "task_...",
  "createdAt": 1794800000000
}
```

- 只记录与“我/项目高度相关”的消息与回复。
- 低相关消息不写正文，只在 `dedup.json` 留 `message_id`。
- 保留 720 天。

### 4.2 记忆记录（memory）

```json
{
  "chatId": "oc_...",
  "date": "2026-11-16",
  "kind": "decision | deadline | commitment | fact | outcome",
  "key": "资产台账拆表-截止",
  "value": "11-20 前完成",
  "sourceMessageIds": ["om_..."],
  "pinned": true,
  "createdAt": 1794800000000
}
```

强制规则：

- `sourceMessageIds` 至少 1 条，否则拒收。
- `kind` 只允许上述 5 种。
- 同一 `chatId + kind + key` 视为同一条；新值覆盖旧值，旧值标记 `supersededBy`。
- `decision / deadline / commitment` 必须 `pinned`，且必须经我确认。
- `fact / outcome` 可自动入库，默认不 pin。

### 4.3 群索引（index.json）

只放：

- 该群 pinned 记录（引用，不复制正文）
- 最近一次提炼时间与水位
- 项目绑定信息
- 文件清单

不放大段正文，避免索引膨胀。

---

## 5. 入库流程

```text
每天一次，每群：
  1. 取昨日相关消息 + 回复 + 任务结论
  2. 一次 LLM 调用：产出候选记忆 JSON
  3. 一次评审调用：逐条核对 sourceMessageIds 与原文
  4. fact / outcome 且评审通过 → 直接入库
  5. decision / deadline / commitment → 私聊我确认，确认后 pin
  6. 评审不通过 → 不写入记忆，原文仍保留
  7. 失败不删原文，次日重试
```

约束：

- 提炼与评审是两个独立调用，不能同一轮自我确认。
- 两者都只读，禁止修改文件、执行命令。
- 记忆内容是数据，不是指令；prompt 明确禁止执行记忆中的命令。
- 单群单日设 token 预算上限。
- 评审必须引用 `sourceMessageIds`，无来源直接驳回。

---

## 6. 召回流程

回答、任务分析、评审时按顺序取：

1. 该群 pinned 的决策 / 截止 / 承诺
2. 该群最近 7 天记忆
3. 关键词命中的历史记忆
4. 相关任务的结论（`outcome`）

限制：

- 条数默认 8，字符上限 2000，可配。
- 冲突时以当前消息为准，记忆只作参考。
- 未确认的决策不进 prompt 的“已确认”区，避免误导。

`chat-context.json` 只保存最近 30 条、7 天，用于连续对话；它不是记忆库。

---

## 7. 保留与清理

| 数据 | 保留 | 说明 |
|------|------|------|
| OpenCode session | 7 天归档 / 30 天删除 | 只清理对话载体 |
| 相关原文与回复 | 720 天 | `replies/<chatId>/<date>.jsonl` |
| 低相关消息 | 不存正文 | 只留 `message_id` |
| 记忆 | pinned 永久；非 pinned 720 天 | `memory/<chatId>/<date>.jsonl` |
| 任务档案 | 长期 | 体积小，review 必需 |
| 热点上下文 | 7 天 / 30 条 | 只给 prompt |
| 审计 | 1 年 | 只记动作与 ID |

**关键澄清**：7/30 天只清理 OpenCode session，不清理证据和记忆。记忆能否召回，取决于是否被提炼进文件，与 session 是否还在无关。

---

## 8. 与群历史的关系

我能在群里看到聊天历史，但机器人不能依赖它：

- 群历史不含机器人的判断理由和历史结论。
- 消息可能被撤回、删除。
- 飞书历史无法按任务、按记忆检索。
- 历史接口受权限与分页限制。

所以机器人必须自己保存：

- 高相关原文证据（720 天）
- 结构化记忆（pinned 永久）
- 任务档案（长期）

---

## 9. 会话设计（不变）

| 用途 | 会话 | 复用 | 清理 |
|------|------|------|------|
| 群锚点 | coordinator | 是 | 长期 |
| 分析 | analyst child | 每任务 | 7 天归档 / 30 天删 |
| 执行 | executor child | 每任务 | 同上 |
| 评审 | reviewer child | 每任务 | 同上 |
| 群回复 | reply child | 否 | 用完即删 |
| 批量筛选 | filter child | 否 | 用完即删 |

- `maxChildrenPerTask=3`、`maxChildrenGlobal=8`、`depth=1`。
- coordinator 不跑 prompt，不做记忆管理，只做锚点和挂 child。
- 任务结束时归档该任务的 child。

---

## 10. 验收标准

- [ ] 无 `sourceMessageIds` 的记忆写入被拒绝。
- [ ] `decision / deadline / commitment` 未经确认不得 pin。
- [ ] 同一 `chatId + kind + key` 更新产生 supersede，不产生重复。
- [ ] 提炼重跑不产生重复记忆。
- [ ] 评审驳回不写记忆，原文仍保留。
- [ ] 720 天证据可按群/日期检索。
- [ ] 可按群/任务/日期删除证据与记忆。
- [ ] session 删除后，证据与记忆仍可召回。
- [ ] 相关原文不进入群聊，只用于机器人与我。
- [ ] 日志、卡片、prompt 中不出现 App Secret、API Key。

---

## 11. 待实现清单

1. `replies/<chatId>/<date>.jsonl` 写入与清理。
2. `memory/<chatId>/<date>.jsonl` 与 `index.json`。
3. 记忆记录 schema 校验（来源必填、kind 白名单）。
4. 每日提炼任务 + 独立评审调用。
5. 高影响记忆的私聊确认与 pin。
6. 召回注入按 pinned → 近期 → 关键词 → 结论。
7. 720 天按文件清理与删除命令。
8. 迁移现有 `memory.json` 到按群/日期结构。
9. 测试：来源缺失拒收、未确认不 pin、supersede、重跑幂等、删除生效。

---

## 12. 非目标

- 不做向量检索（后续可加，记录保留 `sourceMessageIds` 以支持重建）。
- 不做跨租户共享记忆。
- 不做记忆加密（当前依赖本机权限；如需要再单独设计）。
- 不做复杂的信任分级与大批质量指标。
