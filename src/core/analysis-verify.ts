import type { AnalysisVerification, TaskAnalysis } from "./types.js";

const IDENTIFIER_PATTERNS = [
  /`([^`]{3,80})`/g,
  /\b([A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+)\b/g,
  /\b([A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_]+){2,})\b/g,
  /(\/[A-Za-z0-9_\-./{}:]{3,})/g,
];

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function collectIdentifiers(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of IDENTIFIER_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const value = (match[1] ?? "").trim();
      if (value.length < 4) continue;
      if (/^https?:\/\//i.test(value) || /^www\./i.test(value)) continue;
      found.add(value);
    }
  }
  return [...found];
}

export function deterministicVerification(
  analysis: TaskAnalysis,
  corpus: string,
): AnalysisVerification {
  const haystack = corpus.toLowerCase();
  const text = JSON.stringify({
    goal: analysis.goal,
    scope: analysis.scope,
    outOfScope: analysis.outOfScope,
    plan: analysis.plan,
    commands: analysis.commands,
    risks: analysis.risks,
    openQuestions: analysis.openQuestions,
    acceptanceCriteria: analysis.acceptanceCriteria,
  });
  const identifiers = collectIdentifiers(text);
  const unverified = identifiers.filter((identifier) => !haystack.includes(identifier.toLowerCase()));
  return {
    drift: unverified.length > 0 ? "minor" : "none",
    reasons: unverified.slice(0, 8).map((identifier) => `未在群上下文或记忆中找到：${identifier}`),
    unverifiedIdentifiers: unverified.slice(0, 20),
    checked: ["标识符对照群上下文、记忆与任务"],
    ...(analysis.assumptions?.length ? { assumptions: analysis.assumptions } : {}),
  };
}

export function parseVerification(raw: string): Partial<AnalysisVerification> {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return {};
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return {};
    }
  }
  const drift =
    parsed?.drift === "major" || parsed?.drift === "minor" || parsed?.drift === "none"
      ? parsed.drift
      : undefined;
  const assumptions = stringArray(parsed?.assumptions);
  return {
    ...(drift ? { drift } : {}),
    reasons: stringArray(parsed?.reasons),
    unverifiedIdentifiers: stringArray(parsed?.unverified_identifiers),
    checked: stringArray(parsed?.checked),
    ...(assumptions.length > 0 ? { assumptions } : {}),
  };
}

const DRIFT_RANK: Record<AnalysisVerification["drift"], number> = {
  none: 0,
  minor: 1,
  major: 2,
};

export function mergeVerification(
  base: AnalysisVerification,
  extra: Partial<AnalysisVerification>,
): AnalysisVerification {
  const extraDrift = extra.drift ?? "none";
  const drift = DRIFT_RANK[extraDrift] > DRIFT_RANK[base.drift] ? extraDrift : base.drift;
  const assumptions = unique([...(base.assumptions ?? []), ...(extra.assumptions ?? [])]);
  return {
    drift,
    reasons: unique([...base.reasons, ...(extra.reasons ?? [])]),
    unverifiedIdentifiers: unique([
      ...base.unverifiedIdentifiers,
      ...(extra.unverifiedIdentifiers ?? []),
    ]),
    checked: unique([...base.checked, ...(extra.checked ?? [])]),
    ...(assumptions.length > 0 ? { assumptions } : {}),
  };
}
