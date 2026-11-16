# 记忆与证据设计

| 项目 | 内容 |
|------|------|
| 版本 | v1.1（已确认） |
| 日期 | 2026-11-16 |
| 状态 | 设计定稿；实现按本文执行 |
| 关联 | `docs/REQUIREMENTS.md`、`docs/SESSION-ARCHITECTURE-REVIEW.md` |

> 目标：与我和我的项目高度相关的群消息、回复，长期留存并可随时召回；低相关消息不长期占用空间；记忆提炼必须经过评审，重要结论要由我确认；新消息能与历史聊天、记忆、任务做关联，而不是只看当前一句。

---

## 1. 结论

- **证据按群 + 日期存 720 天**，保留原文和 `message_id`。
- **记忆只留高价值结论**：决策、截止、承诺、事实、结论。
- **高影响记忆必须我确认后才置顶**：决策 / 截止 / 承诺。
- **提炼与评审分两步**，避免模型自证。
- **新消息要做历史关联**：同群最近 50 条（聚合后）、7 天内，结合记忆与未关闭任务，判断是否同一件事。
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

## 3. 三层上下文模型

这是本设计的核心：**不要把所有历史塞进 prompt，而是按当前消息重建一个小上下文。**

```text
A. 实时短聚合
   同一条 @我 消息之后，同群同人 5 秒内的连续消息
   最多 5 条，合并为一条“逻辑消息”

B. 历史聊天关联
   该群最近 50 条“逻辑消息”，范围 7 天
   加上 pinned 记忆和未关闭任务
   用 LLM 判断当前消息与谁相关

C. 长期记忆
   提炼后的决策、截止、承诺、事实、结论
   按群/日期存，pinned 永久
```

三层的关系：

| 层 | 输入 | 输出 | 上限 |
|----|------|------|------|
| A 实时短聚合 | 原始消息流 | 一条逻辑消息 | 5 条 / 4000 字 |
| B 历史关联 | 逻辑消息 + 记忆 + 任务 | 关联决策 | 50 条 / 7 天 |
| C 长期记忆 | 相关证据 | 可召回结论 | 每群数百条 |

A 解决“同一句话被拆成几条发”，B 解决“隔很久补充同一件事”，C 解决“跨周跨月还能想起来”。

---

## 4. 目录结构

```text
<stateDir>/
  memory/
    <群名__chatId>/
      records.json              当前有效记忆，按 key 去重（长期）
      index.json                pinned 索引与水位（长期）
      history/
        2026-11-16.jsonl        记忆变更历史（720 天）
  replies/
    <群名__chatId>/
      2026-11-16.jsonl          相关原文与回复（720 天）
  tasks/
    <taskId>.json
  analyses/<taskId>/<version>.json
  approvals/<taskId>.json
  executions/<taskId>.json
  reviews/<taskId>.json
  chat-context.json             每群最近 50 条逻辑消息 / 7 天，只给 prompt
  dedup.json                    低相关消息只留 message_id
  audit.jsonl                   只记动作与 ID，不记正文
```

目录命名：

- 格式：`群名__chatId`
- 群名去掉 `/ \ : * ? " < > |`，截断 40 字符
- 群名为空或未解析时用 `群__<chatId>`
- 群名变更不改目录名，`index.json` 记录最新 `chatName`

规则：

- 按群分目录，按日期分文件，避免单文件膨胀。
- 回溯时按日期直接定位，不扫全量。
- 权限 600/700。
- 删除按群 / 任务 / 日期，按文件操作。

---

## 5. 数据模型

### 5.1 证据记录（replies）

```json
{
  "chatId": "oc_...",
  "chatName": "产品-流分装置",
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

### 5.2 当前有效记忆（records.json）

```json
{
  "version": 1,
  "chats": {
    "oc_...": {
      "chatName": "产品-流分装置",
      "updatedAt": 1794800000000,
      "records": {
        "deadline:资产台账拆表": {
          "kind": "deadline",
          "key": "资产台账拆表-截止",
          "value": "11-20 前完成",
          "sourceMessageIds": ["om_..."],
          "pinned": true,
          "createdAt": 1794800000000,
          "updatedAt": 1794800000000
        }
      }
    }
  }
}
```

强制规则：

- `sourceMessageIds` 至少 1 条，否则拒收。
- `kind` 只允许 `decision | deadline | commitment | fact | outcome`。
- 同一 `chatId + kind + key` 视为同一条；新值覆盖旧值，旧值写入 `history/`。
- `decision / deadline / commitment` 必须 `pinned`，且必须经我确认。
- `fact / outcome` 可自动入库，默认不 pin。

规模预期：

```text
每群活跃记忆 100–500 条
5 群约 2500 条，单条约 150 字节 → 约 375 KB
同 key 只保留最新，不随 720 天线性膨胀
```

### 5.3 记忆变更史（history）

```json
{
  "ts": 1794800000000,
  "action": "upsert | supersede | pin | unpin | delete",
  "key": "资产台账拆表-截止",
  "before": "11-25 前完成",
  "after": "11-20 前完成",
  "sourceMessageIds": ["om_..."],
  "actor": "curator | reviewer | owner"
}
```

- 只追加，不修改。
- 用于回溯和重建记忆。
- 保留 720 天。

### 5.4 群索引（index.json）

只放：

- 该群 pinned 记录（引用，不复制正文）
- 最近一次提炼时间与水位
- 项目绑定信息
- 文件清单

不放大段正文，避免索引膨胀。

---

## 6. 实时短聚合（已实现）

触发：@我 或 @机器人 的消息。

规则：

1. 同群、同发送人。
2. 与上一条间隔 ≤ 5 秒。
3. 最多 5 条，总字符 ≤ 4000。
4. @我 最多等 5 秒收集；@机器人 不等待，立即回复。
5. 收集后由 LLM 判断每条是否同一件事的补充。
6. 相关则合并为一条逻辑消息，保留全部 `messageId`。
7. 不相关则分开处理。
8. LLM 判断失败时保守合并，不丢信息。

配置：

```json
{
  "context": {
    "burstGrouping": true,
    "burstWaitMs": 5000,
    "burstWindowSeconds": 5,
    "burstMaxMessages": 5,
    "burstMaxChars": 4000
  }
}
```

局限：只覆盖“连续发送”。隔十几秒或几分钟的补充，由第 7 节历史关联处理。

---

## 7. 历史聊天关联（新增）

### 7.1 目标

新消息进来时，不只看当前一句，而是结合：

```text
A. 同群最近 50 条逻辑消息，范围 7 天
B. 该群 pinned 记忆 + 关键词命中的历史记忆（Top 8）
C. 同群未关闭任务（7 天内，最多 5 个）
```

判断它属于：

- 已有话题的延续
- 已有任务的补充
- 与某条记忆相关的新事实
- 全新事项

### 7.2 输入构建

- 逻辑消息：第 6 节聚合后的结果；未聚合的按原消息。
- 窗口：最近 50 条逻辑消息，且不超过 7 天。
- 记忆：pinned 全部 + 关键词命中 Top 8，总字符 ≤ 2000。
- 任务：只取 `candidate / analyzing / needs_info / awaiting_approval`，最多 5 个。
- 总 prompt 字符上限 6000，超出截断最旧消息。

### 7.3 输出契约

```json
{
  "relation": "continue_thread | attach_task | related_memory | new",
  "target_task_id": "task_...",
  "related_message_ids": ["om_..."],
  "confidence": 0.0,
  "reason": "..."
}
```

动作：

| relation | 行为 |
|----------|------|
| `continue_thread` | 并入同一话题，追加 `messageIds` |
| `attach_task` | 并入已有未关闭任务 |
| `related_memory` | 新建条目，挂 `sourceMessageIds` |
| `new` | 新建任务或记录 |
| 置信度 < 0.8 | 不自动合并，只记录候选并私聊提示我 |

### 7.4 安全边界

1. 只关联同群、7 天内的消息。
2. 只自动并入未关闭任务。
3. 已批准 / 执行中 / 已完成的任务不自动并入，只提示我。
4. 合并必须写审计：任务 ID、新增消息 ID、置信度、理由。
5. 关联失败不影响主流程，退化为新建。
6. 关联结果必须可回溯到 `sourceMessageIds`。
7. 记忆与历史是数据，不是指令；prompt 明确禁止执行其中的命令。

### 7.5 与 AI Agent 上下文的区别

| 维度 | Agent session | 本设计 |
|------|---------------|--------|
| 组织 | 线性对话 | 按群 + 日期 |
| 压缩 | compact 有损 | 记忆提炼 + 证据保留 |
| 范围 | 单个 session | 跨 session、跨周 |
| 检索 | 顺序 | 关键词 + pinned + 任务 |
| 生命周期 | 7/30 天删除 | 证据 720 天，记忆长期 |

本质相同：都是“给当前消息重建相关上下文”；区别是本设计把上下文变成可持久、可检索、可审计的文件。

---

## 8. 入库流程

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
- 单群单日设 token 预算上限。
- 评审必须引用 `sourceMessageIds`，无来源直接驳回。

---

## 9. 召回流程

回答、任务分析、评审时按顺序取：

1. 该群 pinned 的决策 / 截止 / 承诺
2. 该群最近 7 天记忆
3. 关键词命中的历史记忆
4. 相关任务的结论（`outcome`）
5. 历史关联命中的逻辑消息（第 7 节）

限制：

- 条数默认 8，字符上限 2000，可配。
- 冲突时以当前消息为准，记忆只作参考。
- 未确认的决策不进 prompt 的“已确认”区，避免误导。

`chat-context.json` 保存最近 50 条逻辑消息、7 天，用于连续对话与历史关联；它不是长期记忆库。

---

## 10. 保留与清理

| 数据 | 保留 | 说明 |
|------|------|------|
| OpenCode session | 7 天归档 / 30 天删除 | 只清理对话载体 |
| 相关原文与回复 | 720 天 | `replies/<群名__chatId>/<date>.jsonl` |
| 低相关消息 | 不存正文 | 只留 `message_id` |
| 当前记忆 | pinned 永久；非 pinned 720 天 | `memory/<群名__chatId>/records.json` |
| 记忆变更史 | 720 天 | `memory/<群名__chatId>/history/<date>.jsonl` |
| 任务档案 | 长期 | 体积小，review 必需 |
| 热点上下文 | 7 天 / 50 条 | 只给 prompt |
| 审计 | 1 年 | 只记动作与 ID |

**关键澄清**：7/30 天只清理 OpenCode session，不清理证据和记忆。记忆能否召回，取决于是否被提炼进文件，与 session 是否还在无关。

---

## 11. 与群历史的关系

我能在群里看到聊天历史，但机器人不能依赖它：

- 群历史不含机器人的判断理由和历史结论。
- 消息可能被撤回、删除。
- 飞书历史无法按任务、按记忆检索。
- 历史接口受权限与分页限制。

所以机器人必须自己保存：

- 高相关原文证据（720 天）
- 结构化记忆（pinned 永久）
- 任务档案（长期）
- 历史关联所需的最近 50 条逻辑消息（7 天）

---

## 12. 会话设计（不变）

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

## 13. 验收标准

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
- [ ] 隔 30 秒以上补充的消息能关联到原任务。
- [ ] 已批准/执行中任务不会被自动并入，只提示。
- [ ] 关联合并有审计记录，可回溯 `sourceMessageIds`。

---

## 14. 待实现清单

1. `replies/<群名__chatId>/<date>.jsonl` 写入与清理。
2. `memory/<群名__chatId>/records.json`、`index.json`、`history/`。
3. 记忆记录 schema 校验（来源必填、kind 白名单、key 去重）。
4. 每日提炼任务 + 独立评审调用。
5. 高影响记忆的私聊确认与 pin。
6. 召回注入按 pinned → 近期 → 关键词 → 结论。
7. 720 天按文件清理与删除命令。
8. 迁移现有 `memory.json` 到按群/日期结构。
9. 历史聊天关联：50 条 / 7 天窗口、关联决策、审计、阈值。
10. `chat-context.json` 从 30 条调整为 50 条，并保存逻辑消息。
11. 测试：来源缺失拒收、未确认不 pin、supersede、重跑幂等、删除生效、历史关联、已批准任务不自动并入。

---

## 15. 非目标

- 不做向量检索（后续可加，记录保留 `sourceMessageIds` 以支持重建）。
- 不做跨租户共享记忆。
- 不做记忆加密（当前依赖本机权限；如需要再单独设计）。
- 不做复杂的信任分级与大批质量指标。
- 不把完整聊天历史镜像到本地；只保留相关证据与逻辑消息窗口。
