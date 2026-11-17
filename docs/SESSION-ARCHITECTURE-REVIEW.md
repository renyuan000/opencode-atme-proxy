# 会话与并发架构评审

| 项目 | 内容                                                                         |
|------|------------------------------------------------------------------------------|
| 版本 | v0.2 已实施；v1.3 设计中                                                      |
| 日期 | 2026-11-17                                                                   |
| 对象 | 「主 session + 群会话 + 角色 worker」方案                                      |
| 结论 | v1.3 分层定稿：主 session 锚点、群会话唯一事实源、角色 worker 持久、事件单元调度 |

---

## 1. 评审结论（先说结果）

| 维度     | 评分 | 结论                                                                   |
|----------|------|------------------------------------------------------------------------|
| 简洁     | 6/10 | 当前讨论里混入了不该由 subagent 承担的职责，简化后可达 8/10             |
| 即时响应 | 7/10 | 守护进程 + WS 已经足够；但主 session 串行会拖慢，需要明确"快路径/慢路径" |
| 智能     | 7/10 | 分类、必要性、分析、执行分工合理；缺"记忆检索"和"任务合并"两个关键环节     |
| 可运维   | 6/10 | session 生命周期、归档、失败恢复还没定死                                 |
| 安全     | 7/10 | 审批门禁在，但 subagent 权限边界需要写入配置                            |

**总体：方案可行，但必须先纠正 5 个点，否则会变成"看起来智能、实际又慢又贵"。**

---

## 2. 方案原文（待评审）

```text
主 agent（主 session）负责聊天历史与上下文
 ├─ 一个 subagent 定时拉聊天历史（非 @ 消息）
 ├─ 两个 subagent 按人处理 @我/@机器人
 └─ 长任务交给 subagent，结果回传主 agent
```

### 2.1 与 OpenCode 事实的对照

| 假设                             | 事实                                                                        | 结论                |
|----------------------------------|-----------------------------------------------------------------------------|---------------------|
| subagent 可常驻轮询              | subagent 是一次性 child session，干完即结束；background subagent 仍是实验特性 | ❌ 不能做轮询器      |
| 主 session 负责聊天历史          | 历史应落在确定性存储（JSON/SQLite），LLM 只读取                                | ❌ 不该由 LLM 持有   |
| 按人分 2 个 subagent             | 群上下文属于"群"，不属"人"；交替发言会丢上下文                                | ❌ 分工会割裂上下文  |
| 子会话可见                       | `session list` 默认只列 root（`roots` 参数），child 隐藏属正常                 | ✅ 符合预期          |
| subagent 由主 agent 自己决定调用 | 存在不确定性；我们可直接构造 `subtask` / `parentID` 保证确定性               | ⚠️ 需改为确定性分派 |

证据：

- `opencode agent list`：`explore (subagent)`、`general (subagent)`
- 数据库：`child sessions: 32`、`root sessions: 31`
- SDK：`session.create({ parentID, agent })`、`session.list({ roots })`、`session.update({ time.archived })`
- 二进制：`experimentalBackgroundSubagents:!1`（默认关闭）

---

## 3. 六个必须修正的点

### 修正 1：拉历史不是 subagent，是定时器

- 拉历史是确定性代码：分页、游标、去重、限流。
- 做成 subagent：每轮烧 token、不能常驻、失败不可控。
- 保留现有 `PollingService`，继续按 `intervalSeconds` 运行。
- 失败不前进游标；整批成功才前进（已实现）。

### 修正 2：主 session 不保存历史

- 主 session 只做"对话协调"，不负责持久化。
- 历史由 `chat-context.json`、`memory.json`、`dedup.json`、`cursors.json` 持有。
- 注入主 session 时只带"相关摘要"，不塞全量。
- 这样重启、成本、一致性都可控。

### 修正 3：并发按任务分，不按人分

- 同一群多个同事 @：各自独立任务，互不阻塞。
- 不按人拆 subagent，避免上下文割裂。
- 限流仍按发送者（已有 `SenderLimiter`），但分派按任务。
- 当前 dispatcher 已支持同群 4 并发、跨群并行。

### 修正 4：快路径 / 慢路径分离

| 路径     | 触发                           | 目标延迟 | 执行者                |
|----------|--------------------------------|----------|-----------------------|
| 快路径   | 收到消息、去重、限流、分类、必要性 | 秒级     | 守护进程 + 低成本模型 |
| 确认路径 | 需要用户决策                   | 秒级     | 守护进程发卡片/@      |
| 慢路径   | 任务分析、开发执行、评审         | 分钟级   | child session         |

主 session 不参与快路径的每次判断，否则会被长任务拖住。

### 修正 5：coordinator 只做锚点，不承载并发 prompt

OpenCode 同一 session 并发 prompt 会返回 `SessionBusyError`。如果所有 @消息都打到一个 coordinator：

- 同群 4 并发会互相冲突；
- 长任务会阻塞短回复。

所以：

- coordinator 只作为**可见的 root 锚点**，用于挂 child、存标题、方便你查看；
- 所有实际 prompt 都在 child 执行（reply / analysis / execution / review）；
- 上下文不靠 coordinator 的历史，而靠 `chat-context.json` + `memory.json` 注入；
- 这样并发不冲突，session 列表也只多一个 root/群。

### 修正 6：subagent 必须确定性创建 + 有边界

- 不依赖主 agent "自己想不想调用"。
- 我们直接 `session.create({ parentID: coordinatorId, agent: "atme-analyst" })`。
- 每任务最多 3 个 child：analyst / executor / reviewer。
- 全局 child 上限 8；`subagent_depth=1`。
- child 权限：analyst/reviewer 只读；executor 可写但禁 push/merge/force push。
- 完成 7 天归档，30 天删除；root 长期保留。

---

## 4. 修正后的目标架构

```text
飞书 WS / 定时 poller
        │
        ▼
守护进程（确定性，不烧 token）
  ├─ 去重（message_id）
  ├─ 游标（时间 + lastMessageId）
  ├─ 限流（按发送者）
  ├─ 低成本模型：分类 + 必要性
  └─ 分派
       │
       ├─ 快路径：直接回复 / 群内 @ 主人 / 私聊知会
       │
       └─ child sessions（parentID 指向 coordinator）
             ├─ reply child      快速回复/代答
             ├─ analyst child    只读分析
             ├─ executor child   批准后执行
             └─ reviewer child   只读评审

coordinator（每群/项目 1 个 root，仅作锚点，不跑 prompt）
```

### 4.1 会话生命周期

| 会话            | 数量           | 复用       | 归档      | 删除  |
|-----------------|----------------|------------|-----------|-------|
| coordinator     | 每群/项目 1 个 | 是（仅锚点） | 不归档    | 手动  |
| reply child     | 每消息 1 个    | 否         | 完成 7 天 | 30 天 |
| analysis child  | 每任务 1 个    | 否         | 完成 7 天 | 30 天 |
| execution child | 每任务 1 个    | 否         | 完成 7 天 | 30 天 |
| review child    | 每任务 1 个    | 否         | 完成 7 天 | 30 天 |

### 4.2 并发上限

```json
{
  "concurrency": {
    "global": 8,
    "mentionConcurrency": 4,
    "scanConcurrency": 1,
    "perChat": 1
  },
  "subagents": {
    "maxChildrenPerTask": 3,
    "maxChildrenGlobal": 8,
    "depth": 1
  }
}
```

---

## 5. 是否"够简洁"

**修正后够简洁**，因为：

- 只有 3 类 child，职责固定。
- 拉历史、去重、限流、分类都是确定性代码，不额外建会话。
- 主 session 不做长任务，只做协调。
- 记忆和历史是数据层，不是会话层。

**不够简洁的写法**（应避免）：

- 按人建 subagent；
- 每消息建 root session；
- 让主 agent 自己决定是否开子任务；
- 把聊天历史塞进 session 当存储。

---

## 6. 是否"够即时响应"

| 环节        | 当前       | 目标   | 差距        |
|-------------|------------|--------|-------------|
| WS 接收     | 已有       | 即时   | 无          |
| 去重/限流   | 已有       | 毫秒级 | 无          |
| 分类/必要性 | 低成本模型 | 秒级   | 可接受      |
| 群内 @ 主人 | 已有       | 秒级   | 无          |
| 私聊审批卡  | 已有       | 秒级   | 无          |
| 任务分析    | child      | 分钟级 | 后台，不阻塞 |
| 开发执行    | child      | 分钟级 | 后台，不阻塞 |

**结论：快路径已经是秒级；慢路径后台化后，主流程不会阻塞。** 需要补的是：

1. 快路径不要等待 child 结果；
2. 长任务先回"处理中"；
3. 慢路径失败要回写，不静默。

---

## 7. 是否"够智能"

已有：

- 消息类型识别（question/task/reminder/notification/chat）
- 必要性判断（answer/need_decision/notify_owner/no_reply）
- 任务分析（目标/范围/风险/验收）
- 记忆注入（task/decision/fact/preference/deadline/outcome）
- 项目上下文解析

还缺：

| 缺口           | 影响                       | 建议                                      |
|----------------|----------------------------|-------------------------------------------|
| 任务跨消息合并 | 同一任务多轮讨论会重复建单 | P1-10，按 fingerprint + 语义相似合并       |
| 记忆检索质量   | 关键词匹配可能漏           | 后续可加 embedding；首期先加"最近决策优先" |
| 任务优先级     | 所有任务同权               | 按截止时间/提出人/影响面排序              |
| 结果回写       | 群内默认静默               | 按任务开启，默认私聊                       |
| 评审闭环       | 执行后无独立评审           | reviewer child 检查 diff + 测试           |

**结论：基础智能够用；要"更智能"，优先补任务合并和评审闭环，而不是加更多 subagent。**

---

## 8. 与当前代码的差距

| 项               | 当前                                 | 目标                       | 工作量 |
|------------------|--------------------------------------|----------------------------|--------|
| coordinator 复用 | `sessions.json` 只 load/flush，未使用 | 真正 `chatId -> sessionId` | 中     |
| child 创建       | 每消息新建 root                      | `parentID + agent`         | 中     |
| 会话归档         | 仅 keep/delete                       | 7 天归档、30 天删除         | 中     |
| 快慢路径         | 已在 dispatcher 分层                 | 明确不等待 child           | 小     |
| 任务合并         | 仅 dedupKey                          | 语义合并                   | 大（P1） |
| reviewer         | 无                                   | 只读评审                   | 中     |
| 权限隔离         | analysis/exec 已有                   | 固化为 agent 配置          | 小     |

---

## 9. 建议实施顺序

1. **接上 `sessions.json`**：coordinator 复用 + 失效重建。
2. **确定性 child**：`parentID + agent` 创建 reply/analyst/executor/reviewer。
3. **coordinator 不跑 prompt**：避免 `SessionBusyError`，保持同群并发。
4. **快慢路径显式化**：长任务先回执，child 结果异步回写。
5. **归档策略**：child 完成 7 天归档、30 天删除。
6. **reviewer**：执行后只读评审。
7. **任务合并**（P1）。
8. **记忆检索增强**（P1/P2）。

---

## 10. 实施记录（v0.2）

> 本节是 v0.2 历史记录；当前实现（群摘要会话、持久 worker）见第 12 节。

| 项                      | 状态   | 位置                                                     |
|-------------------------|--------|----------------------------------------------------------|
| coordinator 复用        | 已实现 | `runtime.ts` `coordinatorSession`；`sessions.json` 持久化 |
| 确定性 child            | 已实现 | `runtime.ts` `createChildSession`；`parentID + agent`     |
| coordinator 不跑 prompt | 已实现 | 所有 prompt 在 child                                     |
| 快慢路径                | 已实现 | 分类在守护进程；分析/执行/评审在 child                    |
| 归档/删除               | 已实现 | `sweepSessions`：7 天归档、30 天删除                       |
| reviewer                | 已实现 | `reviewExecution` + `.opencode/agents/atme-reviewer.md`  |
| 并发上限                | 已实现 | `Semaphore(maxChildrenGlobal)`；每任务 3                  |
| 关闭开关                | 已实现 | `subagents.enabled=false` 回退旧行为                     |

仍待 P0-1/P0-2 真实验证：`SessionBusyError` 是否只在 coordinator 出现、child 并发是否受 OpenCode 自身限制、归档 API 是否按预期生效。

## 11. 最终建议（v0.2 历史结论）

- **采纳**：主 coordinator + 3 类 child + 确定性分派 + 快慢路径分离。
- **不采纳**：按人分 subagent、subagent 做轮询、主 session 存历史、每消息建 root。
- **先做**：1–5，能在不增加复杂度的前提下解决 session 膨胀和阻塞问题。
- **后做**：任务合并、记忆检索增强，这些是"更智能"的关键，但不是当前瓶颈。

评审结论：**方案方向正确；修正 5 点后，简洁性 8/10、即时性 8/10、智能 7/10，可以作为下一阶段实现基线。**

---

## 12. v1.3 评审：主 session / 群会话 / 角色 worker

### 12.1 定稿架构

```text
全局主 session（1，持久）
  ├─ 插件管理、owner 私聊、审批、跨群汇总
  └─ 实时收件箱（群事件合并消费）

群会话（每群 1，持久）
  ├─ 唯一群事实源：聚合、组装、摘要、记忆整理
  ├─ 完整性判断 + 按需回溯
  └─ 调度：上下文信封 → 角色 worker

扫描器（确定性代码 + 游标）
  └─ 周期拉历史 → 事件单元 → 群会话

角色 worker（按角色持久，job 隔离）
  ├─ reply（fork）
  ├─ analyst（fork）
  ├─ executor（isolated + worktree）
  └─ reviewer（isolated）
```

### 12.2 与 v0.2 的差异

| 项       | v0.2                     | v1.3                                          |
|----------|--------------------------|-----------------------------------------------|
| 群上下文 | `chat-context.json` 片段 | 群会话独占，持续 ingest                        |
| 组装方式 | 最近 N 条窗口            | 事件单元 + 完整性判断 + 按需回溯              |
| worker   | 每任务临时 child         | reply/analysis/review 每群持久；execution 临时 |
| 扫描     | 定时拉取 + 过滤          | 确定性代码 + 游标，可选 LLM 升级               |
| 并发     | perChat=1，忙则等         | 事件单元队列，worker 并行，上下文单写           |
| 回执     | 无                       | 按实际情况回执，不替代最终结果                 |

### 12.3 评审结论

- **采纳**：主 session 锚点、群会话唯一事实源、角色 worker 持久、事件单元调度。
- **不采纳**：所有东西都做持久 LLM 会话；扫描器烧 LLM；worker 自建群记忆；busy 拒绝。
- **必须守住**：单一事实源、任务上下文隔离、幂等键、上下文单写者、排队不拒绝。

### 12.4 待评审项

1. 群会话组装失败时的降级：只带 pinned + 最近一条，还是直接问一个问题？
2. 角色 worker 的“角色记忆”保留多久、如何清理？
3. 扫描器发现疑似相关但不确定时，升级 LLM 的阈值。
4. 回执文案与表情的默认策略。
5. 全局 worker 上限 8 是否够用，是否需要按群预留。

### 12.5 实施前置审核清单

- [ ] 文档内部无矛盾：事件单元、按需回溯、会话分层三处描述一致。
- [ ] 与当前代码差距已列清，不把设计当实现。
- [ ] 全局主 session、群会话、worker 的边界有单一事实源定义。
- [ ] 并发、队列、回执策略有可验收标准。
- [ ] 提问前检索与三态（resolved / assumed / needs_clarification）有可验收标准。
- [ ] 提问草稿可改写 / 撤销，且撤销留审计。
- [ ] 敏感信息与权限边界未因分层而放宽。
- [ ] 评审通过后再进入编码，不先改代码。

### 12.6 先查后问与提问撤销（已定）

- 提问前必须检索：事件单元 → 群上下文 / 记忆 / 任务 → 仓库 → 配置 / DB。
- 三态：`resolved` / `assumed` / `needs_clarification`。
- 唯一候选不提问；多候选列出让用户选；零候选才开放式问。
- 未检索就提问视为违规，必须记审计。
- 提问先成草稿，审批支持「发送 / 改写 / 重写 / 取消」。
- 私聊说“不用问了，按 X 做” → 转为 `[假设] X` 继续，不发送问题。
- 撤销写审计 `question_cancelled`，任务不自动关闭。
- 任务类消息不得走代答草稿；这是之前“追着问表名”的根因。
