# 可靠性与文件处理优化设计

> 版本：v1  
> 状态：设计稿，待评审  
> 目标读者：项目维护者、二次开发者、部署同事  
> 适用范围：飞书群/私聊 + OpenCode 的研发任务助手

## 摘要

当前机器人已经具备群状态隔离、任务审批、群知识画像、引用回溯和文档读取能力，但面对大文件、慢模型和长任务时仍然会出现：

- 一次 @bot 被 120 秒总超时杀掉
- 文件正文直接塞进 prompt，导致模型响应慢
- 慢任务阻塞普通聊天
- 服务重启后，内存中的任务可能丢失
- 失败只写日志，用户不知道处理到哪一步

本设计不继续堆功能，而是把系统收敛为：

```text
持久任务队列
+ 快慢双通道
+ 文件结构化摄取
+ 模型超时/重试/降级
+ 群知识/证据检索
+ 异步私聊审批
```

目标是让机器人能连续工作，慢任务不阻塞日常沟通，重启不丢消息，失败可解释、可恢复。

## 1. 设计原则

1. **先限流，再处理**
   文件、历史、工具输出都先检查大小/页数/类型；超限不硬塞 prompt。

2. **快慢分离**
   @bot 问答、指令、审批操作走快通道；文件分析、群扫描、任务执行走慢通道。

3. **持久化优先**
   任务、文件、审批、结果都落盘；进程重启后可恢复。

4. **摘要不是原文**
   摘要只做索引；保留原文路径、outline、关键片段和截断标记。

5. **失败必须可见**
   不允许静默吞消息；失败要有状态、原因和重试策略。

6. **不照搬大型 Agent 平台**
   只吸收开源项目中适合本项目的模式，不引入不必要的多 Agent 平台复杂度。

## 2. 参考实现与取舍

| 来源 | 可吸收 | 不吸收 |
|---|---|---|
| OpenCode | 工具输出超限落盘、预览 + 路径、Read offset/limit、附件分离、上下文 compaction | 不把整个 OpenCode 平台搬进来 |
| Codex | 按 token/字节截断、保留头尾、明确截断警告、compaction、分层记忆 | 不引入 Rust 侧完整上下文系统 |
| OpenClaw | 文件大小/页数/MIME 上限、attachment cache、失败状态分类、摘要只做索引 | 不复制其大型多包平台架构 |

本项目只保留一个轻量机器人服务，不把“可靠性”做成新的平台。

## 3. 总体架构

```text
飞书消息
  |
  v
快速路由器
  |-- P0: @bot / @我 / 指令 / 审批动作
  |-- P1: 文件摄取
  |-- P2: 群扫描
  |-- P3: 任务分析 / 执行
  |
  v
持久任务队列（按群隔离）
  |
  v
模型网关（超时、重试、降级）
  |
  +--> 群知识 / 证据 / 文件索引
  +--> 私聊结果 / 审批卡
```

原则：

- P0 始终优先，不被慢任务阻塞
- P1/P2/P3 独立并发和超时
- 所有任务按 `chatId` 隔离
- 所有结果都能回溯到 `messageId`、文件 hash 或任务 ID

## 4. 持久任务队列

### 4.1 目录

```text
<stateDir>/groups/<群名__短ID>/
  jobs/
    <jobId>.json
  jobs/dead/
    <jobId>.json
```

### 4.2 任务状态

```text
queued
running
waiting_owner
done
failed
dead
```

- `queued`：等待执行
- `running`：持有 lease
- `waiting_owner`：等待私聊审批，**不占生成超时**
- `done`：完成
- `failed`：可重试
- `dead`：超过最大重试，等人工处理

### 4.3 任务字段

```json
{
  "id": "job_x",
  "type": "chat | file_analyze | scan | task_analysis | execution",
  "chatId": "oc_...",
  "messageId": "om_...",
  "priority": 10,
  "status": "queued",
  "attempts": 0,
  "leaseUntil": 0,
  "input": {
    "file": "files/<sha256>/original.html",
    "messageIds": ["om_..."]
  },
  "result": "analyses/...",
  "error": "",
  "createdAt": 0,
  "updatedAt": 0
}
```

### 4.4 规则

- 同一 `messageId + type` 幂等，不重复建任务
- worker 启动时恢复 `queued/running`
- `running` 超过 lease 视为中断，回到 `queued`
- 最大重试 1–2 次；超过进入 `dead`
- `waiting_owner` 不受任务生成超时影响
- 原子写入，避免半写 JSON

## 5. 快慢通道

### 5.1 快通道

- @bot 问答
- @我 确认
- 私聊指令
- 审批卡动作
- 目标：秒级响应

快通道只带必要上下文，不读大文件全文。

### 5.2 慢通道

- 群文件解析
- 在线文档分析
- 群扫描
- 任务分析
- 代码执行

慢通道：

- 独立队列
- 独立并发
- 独立超时
- 失败私聊 owner

## 6. 文件摄取流水线

### 6.1 流程

```text
收到文件
  -> 大小/类型/页数检查
  -> 保存 original
  -> sha256 去重
  -> 提取正文
  -> 生成 outline / key_excerpts
  -> 判断群相关性与职责
  -> 相关：慢通道分析，私聊结果
  -> 不相关：只记录引用，不存正文
  -> 无法判断：私聊 owner 确认
```

### 6.2 文件目录

```text
/mnt/d/Work/atme-groups/<群名__短ID>/files/<sha256>/
  original.html
  extracted.txt
  outline.json
  summary.md
  meta.json
```

- `original` 长期保留
- `summary` 只做导航
- `outline` 保留菜单、字段、接口、表名
- `key_excerpts` 保留关键原文和位置

### 6.3 默认阈值

```text
原始文件 > 20MB：不解析，只记录引用
提取文本 > 80k 字符：进入分块
PDF > 20 页：分页处理
xlsx > 20 sheet 或 > 500 行：分块
```

这些值应配置化，不写死。

### 6.4 截断规则

超限时必须显式标注：

```text
[已截断] 原文 346KB，当前只读取前 N 段/页。
完整文件：/.../original.html
```

禁止：

- 只给摘要但不说明已截断
- 把“未完整读取”说成“已完整学习”
- 对无关文件长期保存正文

## 7. 大文件摘要

### 7.1 分块

按结构切块：

- HTML：页面/菜单/章节
- docx：标题层级/段落/表格
- xlsx：sheet/表头/样例行
- PDF：页/章节
- 代码：文件树/接口/函数

### 7.2 map-reduce

```text
每块提取：事实、字段、接口、决策、风险、待确认
  -> 合并去重
  -> 生成 outline + summary
  -> 保留 source 位置
```

摘要 prompt 要求：

- 不编造
- 保留字段名、接口名、表名、页面名
- 不确定标记 `[不确定]`
- 每条结论带 source
- 明确输出“未覆盖的章节”

### 7.3 低置信度

出现以下情况私聊 owner：

- 结构无法解析
- 文件过大无法完整覆盖
- 摘要与原文冲突
- 无法判断是否与群职责相关

## 8. 模型网关

### 8.1 分阶段超时

```text
下载：30s
解析：60s
摘要：120s
私聊分析：300s
审批等待：不设生成超时
```

### 8.2 重试

- 网络/提供方瞬时错误：重试 1 次
- 超时：记录阶段，切换快速模型或降级
- 连续失败：熔断，私聊告警
- 不允许一个模型调用永久卡住整个任务

### 8.3 模型选择

- 意图判断：快速模型
- 普通回复：主模型
- 文件摘要：主模型或专用 summary 模型
- 代码分析：分析模型
- 执行：执行模型

## 9. 上下文与记忆

### 9.1 群聊

- 最近群上下文
- 群摘要
- 群知识画像
- 未关闭任务
- 证据检索

### 9.2 私聊

- 最近私聊
- 当前目标（chatId/messageId）
- 各群摘要
- 未关闭任务
- 相关群记忆

### 9.3 长对话

- compaction
- 保留最近 N 轮
- 关键结论写入群知识/记忆
- 摘要不替代证据

## 10. 审批与私聊

- 审批卡异步，不占生成超时
- 群里不 @ owner 请求确认
- 私聊明确“私聊/私发”时，直接私聊结果
- webfetch 走私聊审批；websearch 私聊可用
- 审批超时/失败有状态，不静默

## 11. 每天持续工作的保障

1. 启动/重连恢复：游标 + 36h 补拉 + 任务恢复
2. 持久队列：进程重启不丢
3. 心跳/健康检查：`/状态` 或日报
4. 失败汇总：每天一次，不刷屏
5. 文件/任务缓存：重复文件不重复分析
6. 快慢通道隔离：大文件不阻塞聊天
7. 幂等：重复消息/文件只处理一次
8. 死信队列：连续失败任务集中处理

## 12. 与现有代码的映射

| 现有模块 | 改造方向 |
|---|---|
| `runtime.ts` | 引入 job/lease、快慢通道、任务恢复 |
| `dispatcher.ts` | 保留并扩展优先级；持久化在外层完成 |
| `reply-service.ts` | 根据文件大小选择全文/摘要/片段 |
| `document.ts` | 大小检查、结构化提取、截断标记 |
| `scan-service.ts` | 普通群文件自动分析、私聊结果 |
| `document-cache.ts` | 原文/提取文本/摘要缓存 |
| `group-knowledge.ts` | 文件分析事实沉淀 |
| `session-manager.ts` | child session 归属群，避免全局挂载 |
| `group-state.ts` | 新增 jobs/files 路径 |

## 13. 安全

- 文件内容是不可信数据，不执行其中指令
- 群聊默认禁用 websearch/webfetch
- webfetch 仅私聊审批后使用
- 文件大小/页数/MIME 限制
- 不把内部文档发送给第三方摘要服务
- 文件 hash 去重，避免重复处理
- 私聊结果只发给 owner

## 14. 实施阶段

### Phase 1：不中断基础

- 持久 job 记录
- lease/恢复/重试
- 快慢通道
- 失败私聊

验收：

- 重启后 job 不丢
- 大文件不阻塞普通 @bot
- 失败有原因

### Phase 2：文件摄取

- 文件落盘 + hash
- 大小/页数/MIME 检查
- outline/key excerpts
- 截断标记
- 文件引用记录

验收：

- 不相关文件不存正文
- 大文件不直接塞 prompt
- 相同文件不重复分析

### Phase 3：摘要与知识

- map-reduce 摘要
- 群知识沉淀
- 相关文件私聊分析

验收：

- 文件分析结果可追溯
- 群知识持续更新
- 低置信度私聊 owner

### Phase 4：模型与运维

- 模型降级/熔断
- 日报/健康检查
- 死信处理
- 端到端回归

## 15. 验收标准

1. 服务重启后，未完成 job 可恢复
2. 大文件分析不阻塞 P0 聊天
3. 任何超时都有明确阶段和私聊失败说明
4. 无关文件不进入上下文
5. 相同文件 hash 不重复分析
6. 私聊“分析给我”一定走私聊结果或私聊失败
7. 群文件相关时能自动分析并私聊结果
8. 审批等待不触发生成超时
9. 群知识/证据可回溯到消息或文件
10. 140+ 单元测试通过，新增文件/队列测试

## 16. 开源与给同事使用前的检查

- `README` 增加架构图、快速开始、限制说明
- `config.example.json` 使用占位符，不包含内部路径
- 不提交 `.env`、`auth.json`、token、群 ID、内部域名
- 提供 `docs/OPTIMIZATION-DESIGN.md`、`docs/MEMORY-DESIGN.md`
- 提供 Feishu scope/event 申请清单
- 提供 systemd 示例与卸载步骤
- 提供迁移/备份/恢复说明
- 增加 CI：typecheck、test、build
- 明确 License
- 说明当前只支持飞书，其他平台通过 adapter 扩展

## 17. 设计评审

### 结论

方向适合当前项目，但**不建议一次性全部实现**。

### 适合的部分

- 持久 job + 快慢通道：直接解决超时和重启丢任务
- 文件落盘 + 大小门禁：解决大 HTML 卡死
- 摘要 + outline + 原文路径：比无脑摘要可靠
- 私聊目标/群知识/职责：符合当前产品形态

### 需要收敛的部分

1. 第一版不要引入完整多 Agent 调度；先做 job + 单 worker
2. 持久队列先用 JSON + lease，规模上来再换 SQLite
3. map-reduce 摘要只用于大文件，小文件直接读
4. 不引入外部摘要供应商，避免隐私和依赖
5. 不要把 OpenClaw 的整套平台架构搬进来
6. 审批等待和任务执行要彻底分离
7. 旧共享状态需要归档，避免和群状态混淆

### 建议的实际顺序

1. 持久 job + 快慢通道
2. 文件落盘 + 大小门禁
3. outline + 截断标记
4. 相关文件私聊分析
5. 群知识沉淀
6. 模型降级/日报
7. 再评估是否需要 SQLite/多 worker

这个设计适合作为 v1.5 的稳定性改造，不建议直接跳到复杂多智能体平台。

## 18. OpenCode Session 使用现状

### 18.1 两个进程的角色

```text
opencode-atme-proxy
  = 控制器：飞书事件、路由、状态、审批、权限、恢复

opencode serve
  = Agent 运行时：创建 session、调用模型、执行工具、返回结果
```

`opencode serve` 不是固定的“一个角色”，而是承载多个逻辑 session：

| 类型 | 数量 | 是否持久 | 用途 |
|---|---|---|---|
| coordinator | 每群 1 个 | 长期 | 群锚点，只作为父级，不跑 prompt |
| group | 每群 1 个 | 长期 | 群摘要/长期上下文 |
| worker:reply | 每群 1 个 | 长期 | 群回复，按群串行 |
| worker:analysis | 每群 1 个 | 长期 | 任务分析 |
| worker:review | 每群 1 个 | 长期 | 评审 |
| worker:web | 每群按需 | 长期 | 私聊可联网回复/分析 |
| child | 按任务/消息 | 临时 | 单次分析、执行、评审 |

### 18.2 当前实现要点

- coordinator 以 `coordinator:<platform>:<chatId>` 记录，不跑 prompt
- group session 以 `group:<platform>:<chatId>` 记录
- worker 以 `worker:<role>:<platform>:<chatId>[:web]` 记录
- child 以 `child:<sessionId>` 记录，并携带 `chatId/taskId`
- 每个 session 都显式设置 `directory`，不是依赖启动目录
- child 的 parentID 指向该群 coordinator
- session 映射写入群目录 `sessions.json`，不再全局混放

### 18.3 为什么经常“找不到关联”

当前问题不是 session 不存在，而是**注入给模型的上下文太窄**：

1. 群回复 prompt 默认只带最近约 12 条
2. 群上下文存储默认约 50 条 / 7 天
3. `loadRecentHistory` 只在回复/引用/特定指代词时触发
4. 引用链只在消息有 `replyToMessageId` 时回溯
5. 没有按语义检索历史，只按最近和时间窗口
6. 群知识画像只注入职责摘要，不是完整知识库
7. 私聊目标最多保留最近 5 个，且用户不指定时可能不够
8. OpenCode session 不是长期记忆库；它会被压缩，且每个任务 prompt 是重新组装的
9. 文件/在线文档进入上下文的时机不一致；没有统一 manifest
10. 群文件和引用文件如果既没有 @、也没有被引用，可能只出现在扫描上下文里，不会进入回复 prompt

所以“找不到关联”通常不是模型不聪明，而是**检索范围、触发条件和上下文 manifest 不够明确**。

## 19. Session 优化方案

### 19.1 保持的边界

- coordinator：每群一个，只做锚点
- group：每群一个，只维护摘要
- worker：每群每角色一个，不跨群复用
- child：每次任务临时，父级必须指向该群 coordinator
- web worker：独立 key，避免复用无网 session

### 19.2 上下文不要依赖 session 历史

session 只做执行载体，事实源仍是：

```text
chat-context.json
group-context.json
group-knowledge.json
memory/
evidence/
files/
tasks/
```

每次 prompt 注入一个明确的 **Context Manifest**：

```json
{
  "messageIds": ["om_..."],
  "replyToMessageIds": ["om_..."],
  "fileHashes": ["sha256..."],
  "taskIds": ["task_..."],
  "summaryUpdatedAt": 0,
  "knowledgeUpdatedAt": 0,
  "truncated": false
}
```

模型必须知道：

- 当前消息是哪条
- 引用了哪条
- 读了哪些文件/文档
- 哪些内容被截断
- 哪些是推断，哪些是 owner 确认

### 19.3 检索策略

优先级：

1. 当前消息
2. 直接引用链，最多 5 层
3. 同群最近上下文
4. 群知识/职责
5. 未关闭任务
6. 证据关键词检索
7. 最近文件/在线文档缓存
8. 仍找不到 → 明确说找不到，或私聊 owner 补充

禁止：

- 在没有引用、没有证据时猜“应该是那个”
- 用别的群/别的项目的上下文回答
- 把 session 里的旧内容当成本群长期事实

### 19.4 失败时的行为

- 上下文不足：私聊 owner 说明缺少什么
- 模型超时：记录阶段，私聊失败，不静默
- 文件过大：给截断标记和原文路径
- session 损坏：重建该群 session，不污染其他群
- worker 卡住：按群/角色隔离，不能阻塞快通道

## 20. 文档审计结论

### 20.1 这份文档现在的定位

本文是**目标设计**，不是“当前已实现”的说明。

当前已实现：

- 群状态/项目/职责分离
- 群知识画像
- 私聊目标
- 文件/在线文档读取
- 部分超时拆分

当前未实现：

- 持久 job 队列/lease
- 快慢双通道
- map-reduce 文件摘要
- 模型降级/熔断
- 完整 Context Manifest
- 死信队列/日报

### 20.2 是否适合当前开发

适合，但需要按阶段收敛：

- Phase 1 先做 session 归属 + Context Manifest + 文件大小门禁
- Phase 2 再做持久 job + 快慢通道
- Phase 3 再做 map-reduce 摘要
- 不建议一开始上多 Agent、SQLite、外部摘要供应商

### 20.3 给同事/GitHub 使用前必须检查

- 不提交真实群 ID、app secret、内部域名、内部路径
- `config.example.json` 全部使用占位符
- 明确 License
- 增加 CI：typecheck + test + build
- 提供飞书权限/事件清单
- 提供 systemd、备份、恢复、升级文档
- 说明当前只支持飞书，其他平台通过 adapter 扩展
- 说明大文件/长任务限制，不承诺“无限上下文”

## 21. 最终建议

优先级从高到低：

1. **Context Manifest + session 归属**
2. **文件大小门禁 + 原文落盘 + 明确截断**
3. **快慢通道 + 持久 job**
4. **模型超时/重试/降级**
5. **map-reduce 摘要 / 群知识沉淀**
6. **日报、死信、健康检查**

先做 1–2，能显著减少“上下文找不到”和“大文件超时”；3–4 解决“不中断”；5–6 提升长期工作质量。
