import assert from "node:assert/strict";
import test from "node:test";
import {
  collectIdentifiers,
  deterministicVerification,
  mergeVerification,
  parseVerification,
} from "../src/core/analysis-verify.js";
import type { TaskAnalysis } from "../src/core/types.js";

function analysis(overrides: Partial<TaskAnalysis> = {}): TaskAnalysis {
  return {
    taskId: "t1",
    version: 1,
    needsInfo: false,
    goal: "把写入目标切到 asset_account",
    scope: ["asset_ip"],
    outOfScope: [],
    repos: ["repo"],
    plan: [],
    commands: [],
    risks: [],
    openQuestions: [],
    acceptanceCriteria: [],
    model: "test",
    createdAt: 0,
    planHash: "",
    ...overrides,
  };
}

test("collects snake_case, dotted and path identifiers", () => {
  const ids = collectIdentifiers("用 asset_account.asset_ip 调 /api/v1/assets，字段 asset_type");
  assert.ok(ids.includes("asset_account"));
  assert.ok(ids.includes("asset_type"));
  assert.ok(ids.some((id) => id.startsWith("/api/")));
});

test("flags identifiers absent from the context corpus", () => {
  const clean = deterministicVerification(analysis(), "群里只提到 asset_account 和 asset_ip");
  assert.equal(clean.drift, "none");
  const missing = deterministicVerification(
    analysis({ goal: "改成 asset_ledger" }),
    "群里只提到 asset_account",
  );
  assert.equal(missing.drift, "minor");
  assert.ok(missing.unverifiedIdentifiers.includes("asset_ledger"));
});

test("merges reviewer output and keeps highest drift", () => {
  const base = deterministicVerification(analysis(), "asset_account asset_ip");
  const merged = mergeVerification(base, {
    drift: "major",
    reasons: ["扩大了范围"],
    unverifiedIdentifiers: ["x_api"],
  });
  assert.equal(merged.drift, "major");
  assert.ok(merged.reasons.includes("扩大了范围"));
  assert.ok(merged.unverifiedIdentifiers.includes("x_api"));
});

test("parses verification json", () => {
  const parsed = parseVerification(
    '{"drift":"minor","reasons":["范围偏大"],"unverified_identifiers":["asset_ledger"],"checked":["仓库"]}',
  );
  assert.equal(parsed.drift, "minor");
  assert.deepEqual(parsed.unverifiedIdentifiers, ["asset_ledger"]);
});
