import type { Logger } from "./logger.js";
import type { LlmClient } from "./relevance.js";
import type { TaskState } from "./types.js";
import { parseJsonLoose } from "./relevance.js";
import { clamp, toErrorMessage } from "./util.js";

export type TaskAdminAction = "list" | "reanalyze" | "archive" | "restore";

export interface TaskAdminIntent {
  action: TaskAdminAction;
  group?: string;
  states: TaskState[];
  olderThanDays?: number;
  limit: number;
  reason?: string;
  confidence: number;
}

export interface TaskAdminIntentOptions {
  llm?: LlmClient;
  groups: string[];
  logger: Logger;
}

const ADMIN_ACTIONS =
  /(重新分析|重新判断|重跑|再分析|重判|归档|清理|淘汰|冻结|恢复|盘点|看看|查看|列出|列表|有哪些|多少)/;
const ACTION_WORDS: Record<TaskAdminAction, RegExp> = {
  reanalyze: /(重新分析|重新判断|重跑|再分析|重判)/,
  archive: /(归档|清理|淘汰|冻结|收起来)/,
  restore: /(恢复|取消归档|解冻)/,
  list: /(看看|列出|查看|盘点|有哪些|列表|多少)/,
};
const STATES: TaskState[] = [
  "candidate",
  "analyzing",
  "needs_info",
  "awaiting_approval",
  "approved",
  "executing",
  "verifying",
  "awaiting_merge",
  "done",
  "rejected",
  "failed",
  "canceled",
  "expired",
];

export class TaskAdminService {
  constructor(private readonly options: TaskAdminIntentOptions) {}

  async infer(text: string): Promise<TaskAdminIntent | undefined> {
    const trimmed = text.trim();
    if (!ADMIN_ACTIONS.test(trimmed) || !/(任务|待办|历史)/.test(trimmed)) return undefined;
    const fallback = this.deterministic(trimmed);
    if (!this.options.llm) return fallback;
    try {
      const completion = await this.options.llm.complete([
        {
          role: "system",
          content: [
            "你是任务管理意图解析器。只输出严格 JSON，不执行任何操作。",
            "动作只能是 list、reanalyze、archive、restore；删除类请求一律降级为 archive，不能输出 delete。",
            `可用群：${this.options.groups.join("、")}`,
            "字段：action, group(可空), states(TaskState 数组), olderThanDays(数字可空), limit(1-50), reason, confidence(0-1)。",
            "不确定时给 confidence < 0.5，不要猜群。",
          ].join("\n"),
        },
        { role: "user", content: trimmed },
      ]);
      const parsed = parseJsonLoose(completion.text) as Record<string, unknown>;
      const action = this.action(parsed.action);
      if (!action) return fallback;
      const states = Array.isArray(parsed.states)
        ? parsed.states.filter(
            (state): state is TaskState => typeof state === "string" && STATES.includes(state as TaskState),
          )
        : [];
      const parsedLimit = Number(parsed.limit ?? fallback?.limit ?? 10);
      const limit = Number.isFinite(parsedLimit) ? clamp(parsedLimit, 1, 50) : 10;
      const parsedConfidence = Number(parsed.confidence ?? 0);
      const olderThanDays =
        typeof parsed.olderThanDays === "number" && Number.isFinite(parsed.olderThanDays)
          ? Math.max(0, Math.floor(parsed.olderThanDays))
          : undefined;
      return {
        action,
        ...(typeof parsed.group === "string" && parsed.group.trim()
          ? { group: parsed.group.trim() }
          : {}),
        states,
        ...(olderThanDays !== undefined ? { olderThanDays } : {}),
        limit,
        ...(typeof parsed.reason === "string" && parsed.reason.trim()
          ? { reason: parsed.reason.trim() }
          : {}),
        confidence: Number.isFinite(parsedConfidence) ? clamp(parsedConfidence, 0, 1) : 0,
      };
    } catch (error) {
      this.options.logger.warn("task admin LLM intent failed; using deterministic fallback", {
        error: toErrorMessage(error),
      });
      return fallback;
    }
  }

  private action(value: unknown): TaskAdminAction | undefined {
    if (value === "list" || value === "reanalyze" || value === "archive" || value === "restore") {
      return value;
    }
    return undefined;
  }

  private deterministic(text: string): TaskAdminIntent {
    const action: TaskAdminAction = ACTION_WORDS.reanalyze.test(text)
      ? "reanalyze"
      : ACTION_WORDS.archive.test(text)
        ? "archive"
        : ACTION_WORDS.restore.test(text)
          ? "restore"
          : "list";
    const states = STATES.filter((state) => text.toLowerCase().includes(state));
    if (/待审批/.test(text) && !states.includes("awaiting_approval")) states.push("awaiting_approval");
    if (/已完成|完成了/.test(text) && !states.includes("done")) states.push("done");
    if (/失败/.test(text) && !states.includes("failed")) states.push("failed");
    const limitMatch = text.match(/(?:最多|限制|前|top)\s*(\d{1,3})|(\d{1,3})\s*(?:条|个)/i);
    const dayMatch = text.match(/(\d{1,4})\s*(?:天|日)/);
    return {
      action,
      states,
      limit: clamp(Number(limitMatch?.[1] ?? limitMatch?.[2] ?? 10), 1, 50),
      ...(dayMatch ? { olderThanDays: Math.max(0, Number(dayMatch[1])) } : {}),
      reason: "deterministic fallback",
      confidence: 0.6,
    };
  }
}
