export type FilterFailureKind =
  | "model_timeout"
  | "job_timeout"
  | "transport_error"
  | "output_parse"
  | "config_error"
  | "model_error"
  | "unknown";

export interface FilterFailure {
  kind: FilterFailureKind;
  message: string;
  model?: string;
  timeoutMs?: number;
}

export function classifyFilterFailure(error: unknown): FilterFailure {
  const source = error as { kind?: unknown; model?: unknown; timeoutMs?: unknown } | undefined;
  const message = error instanceof Error ? error.message : String(error ?? "unknown");
  const kind =
    typeof source?.kind === "string" &&
    [
      "model_timeout",
      "job_timeout",
      "transport_error",
      "output_parse",
      "config_error",
      "model_error",
      "unknown",
    ].includes(source.kind)
      ? (source.kind as FilterFailureKind)
      : /job timed out/i.test(message)
        ? "job_timeout"
        : /timed out|timeout/i.test(message)
          ? "model_timeout"
          : /invalid json|parse|missing content/i.test(message)
            ? "output_parse"
            : /fetch failed|econn|network|socket|connection.*reset|aborted/i.test(message)
              ? "transport_error"
              : /no model|model unresolved|configuration|not configured/i.test(message)
                ? "config_error"
                : "model_error";
  return {
    kind,
    message,
    ...(typeof source?.model === "string" && source.model ? { model: source.model } : {}),
    ...(typeof source?.timeoutMs === "number" ? { timeoutMs: source.timeoutMs } : {}),
  };
}

export function describeFilterFailure(failure: FilterFailure): string {
  const seconds = failure.timeoutMs ? `${Math.round(failure.timeoutMs / 1000)} 秒` : "限定时间";
  switch (failure.kind) {
    case "model_timeout":
      return `筛选模型请求超时（${seconds}）——模型没有在限定时间内返回。`;
    case "job_timeout":
      return "筛选任务整体超时——可能是 OpenCode 会话/进程卡住，或上游流式连接没有正常结束。";
    case "transport_error":
      return "与筛选模型/网关的连接中断。";
    case "output_parse":
      return "筛选模型返回的内容不是有效 JSON。";
    case "config_error":
      return "筛选模型配置不完整或不可用。";
    case "model_error":
      return "筛选模型或 OpenCode 返回错误。";
    default:
      return "筛选模型调用失败。";
  }
}
