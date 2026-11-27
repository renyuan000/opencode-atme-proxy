import assert from "node:assert/strict";
import test from "node:test";
import { classifyFilterFailure, describeFilterFailure } from "../src/core/filter-error.js";

test("classifies filter timeouts and job timeouts separately", () => {
  const model = classifyFilterFailure(new Error("filter timed out after 60000ms"));
  assert.equal(model.kind, "model_timeout");
  assert.match(describeFilterFailure(model), /筛选模型请求超时/);

  const job = classifyFilterFailure(new Error("job timed out after 120000ms"));
  assert.equal(job.kind, "job_timeout");
  assert.match(describeFilterFailure(job), /整体超时/);
});

test("classifies transport, parse, and configuration failures", () => {
  assert.equal(classifyFilterFailure(new Error("fetch failed: ECONNRESET")).kind, "transport_error");
  assert.equal(classifyFilterFailure(new Error("invalid JSON from model")).kind, "output_parse");
  assert.equal(classifyFilterFailure(new Error("filter model unresolved")).kind, "config_error");
});

test("uses structured error metadata when present", () => {
  const error = Object.assign(new Error("failed"), {
    kind: "model_timeout",
    model: "opencode-go/deepseek-v4.1-flash",
    timeoutMs: 60_000,
  });
  const failure = classifyFilterFailure(error);
  assert.equal(failure.kind, "model_timeout");
  assert.equal(failure.model, "opencode-go/deepseek-v4.1-flash");
  assert.equal(failure.timeoutMs, 60_000);
});
