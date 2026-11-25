import assert from "node:assert/strict";
import test from "node:test";
import { TaskAdminService } from "../src/core/task-admin.js";
import type { LlmClient } from "../src/core/relevance.js";

const logger = {
  warn() {},
  info() {},
  error() {},
  child() { return this; },
} as any;

function llm(output: string): LlmClient {
  return {
    async complete() {
      return {
        text: output,
        model: "test",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
  };
}

test("infers task reanalysis intent with group and states", async () => {
  const service = new TaskAdminService({
    llm: llm(JSON.stringify({ action: "reanalyze", group: "产品-流分装置", states: ["needs_info"], limit: 5, confidence: 0.9 })),
    groups: ["产品-流分装置"],
    logger,
  });
  const intent = await service.infer("把流分装置历史任务重新分析一下");
  assert.equal(intent?.action, "reanalyze");
  assert.equal(intent?.group, "产品-流分装置");
  assert.deepEqual(intent?.states, ["needs_info"]);
  assert.equal(intent?.limit, 5);
});

test("falls back deterministically and never infers delete", async () => {
  const service = new TaskAdminService({ groups: ["产品-流分装置"], logger });
  const intent = await service.infer("把产品-流分装置的 needs_info 任务归档 20 条");
  assert.equal(intent?.action, "archive");
  assert.equal(intent?.limit, 20);
});
