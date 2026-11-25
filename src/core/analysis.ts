import { parseJsonLoose } from "./relevance.js";
import type { TaskAnalysis, TaskRecord } from "./types.js";
import { sha256 } from "./util.js";

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function parseAnalysis(
  raw: string,
  task: TaskRecord,
  fallbackRepo: string,
): TaskAnalysis {
  let parsed: any;
  try {
    parsed = parseJsonLoose(raw);
  } catch {
    parsed = {};
  }
  const repos = Array.isArray(parsed?.repos)
    ? parsed.repos.filter((repo: unknown): repo is string => typeof repo === "string")
    : [];
  const result: TaskAnalysis = {
    taskId: task.id,
    version: 1,
    needsInfo: Boolean(parsed?.needs_info),
    goal: typeof parsed?.goal === "string" ? parsed.goal : task.title,
    scope: stringArray(parsed?.scope),
    outOfScope: stringArray(parsed?.out_of_scope),
    repos: repos.length > 0 ? repos : [fallbackRepo],
    files: stringArray(parsed?.files),
    plan: Array.isArray(parsed?.plan)
      ? parsed.plan
          .filter((step: unknown) => step && typeof step === "object")
          .map((step: any) => ({
            step: typeof step.step === "string" ? step.step : "step",
            ...(typeof step.detail === "string" ? { detail: step.detail } : {}),
          }))
      : [],
    commands: stringArray(parsed?.commands),
    risks: stringArray(parsed?.risks),
    openQuestions: stringArray(parsed?.open_questions),
    acceptanceCriteria: stringArray(parsed?.acceptance_criteria),
    assumptions: stringArray(parsed?.assumptions),
    checked: stringArray(parsed?.checked),
    ...(typeof parsed?.estimate === "string" ? { estimate: parsed.estimate } : {}),
    model: "main_agent",
    createdAt: Date.now(),
    planHash: "",
  };
  result.planHash = sha256(
    JSON.stringify({
      repos: result.repos,
      commands: result.commands,
      acceptance: result.acceptanceCriteria,
      plan: result.plan,
    }),
  ).slice(0, 16);
  return result;
}
