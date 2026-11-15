import assert from "node:assert/strict";
import test from "node:test";
import { SenderLimiter } from "../src/core/sender-limiter.js";

test("limits per sender and refills over time", () => {
  let now = 0;
  const limiter = new SenderLimiter({
    maxPerMinute: 2,
    maxConcurrent: 10,
    cooldownMs: 0,
    now: () => now,
  });
  limiter.acquire("alice")();
  limiter.acquire("alice")();
  assert.equal(limiter.tryAcquire("alice"), false);
  limiter.acquire("bob")();
  now = 61_000;
  limiter.acquire("alice")();
});

test("enforces per-sender concurrency", () => {
  const limiter = new SenderLimiter({ maxPerMinute: 100, maxConcurrent: 1, cooldownMs: 0 });
  const release = limiter.acquire("alice");
  assert.equal(limiter.tryAcquire("alice"), false);
  limiter.acquire("bob")();
  release();
  limiter.acquire("alice")();
});

test("cooldown blocks repeated triggers", () => {
  let now = 0;
  const limiter = new SenderLimiter({
    maxPerMinute: 100,
    maxConcurrent: 10,
    cooldownMs: 5000,
    now: () => now,
  });
  limiter.acquire("alice")();
  assert.equal(limiter.tryAcquire("alice"), false);
  now = 5001;
  limiter.acquire("alice")();
});

test("first offender gets a warning before being dropped", () => {
  const limiter = new SenderLimiter({ maxPerMinute: 1, maxConcurrent: 10, cooldownMs: 0 });
  limiter.acquire("alice")();
  assert.equal(limiter.shouldWarn("alice"), true);
  assert.equal(limiter.tryAcquire("alice"), false);
  assert.equal(limiter.shouldWarn("alice"), false);
});
