import assert from "node:assert/strict";
import test from "node:test";
import { assertTransition, canTransition, isTerminal } from "../src/core/task-state.js";

test("valid transitions", () => {
  assert.equal(canTransition("candidate", "analyzing"), true);
  assert.equal(canTransition("awaiting_approval", "approved"), true);
  assert.equal(canTransition("approved", "executing"), true);
  assert.equal(canTransition("executing", "verifying"), true);
  assert.equal(canTransition("verifying", "done"), true);
});

test("invalid transitions are rejected", () => {
  assert.equal(canTransition("candidate", "executing"), false);
  assert.throws(() => assertTransition("candidate", "executing"), /invalid task transition/);
  assert.equal(canTransition("done", "executing"), false);
});

test("terminal states", () => {
  assert.equal(isTerminal("done"), true);
  assert.equal(isTerminal("rejected"), true);
  assert.equal(isTerminal("canceled"), true);
  assert.equal(isTerminal("failed"), false);
});
