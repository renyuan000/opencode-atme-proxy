import assert from "node:assert/strict";
import test from "node:test";
import { ConcurrentDispatcher } from "../src/core/dispatcher.js";
import { QueueFullError } from "../src/core/types.js";

function create(overrides: Partial<ConstructorParameters<typeof ConcurrentDispatcher>[0]> = {}) {
  return new ConcurrentDispatcher({
    concurrency: 4,
    perKeyConcurrency: 1,
    maxQueue: 100,
    defaultTimeoutMs: 1000,
    ...overrides,
  });
}

test("per-key jobs run serially while different keys run concurrently", async () => {
  const dispatcher = create({ concurrency: 4, perKeyConcurrency: 1 });
  const order: string[] = [];
  const jobs: Promise<string>[] = [];
  for (const key of ["a", "b", "c", "d"]) {
    for (let index = 0; index < 2; index++) {
      const id = `${key}${index}`;
      jobs.push(
        dispatcher.enqueue({
          id,
          key,
          run: async () => {
            order.push(`start:${id}`);
            await new Promise((resolve) => setTimeout(resolve, 20));
            order.push(`end:${id}`);
            return id;
          },
        }),
      );
    }
  }
  await Promise.all(jobs);
  for (const key of ["a", "b", "c", "d"]) {
    const firstEnd = order.indexOf(`end:${key}0`);
    const secondStart = order.indexOf(`start:${key}1`);
    assert.ok(firstEnd >= 0 && secondStart > firstEnd, `${key} ran out of order`);
  }
});

test("mention keyConcurrency allows concurrent mentions in one chat", async () => {
  const dispatcher = create({ concurrency: 4, perKeyConcurrency: 1 });
  let active = 0;
  let peak = 0;
  const jobs: Promise<void>[] = [];
  for (let index = 0; index < 3; index++) {
    jobs.push(
      dispatcher.enqueue({
        id: `m${index}`,
        key: "chat",
        keyConcurrency: 3,
        priority: 1,
        run: async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 20));
          active--;
        },
      }),
    );
  }
  await Promise.all(jobs);
  assert.equal(peak, 3);
});

test("priority jobs run before background jobs", async () => {
  const dispatcher = create({ concurrency: 1, perKeyConcurrency: 1 });
  const order: string[] = [];
  const first = dispatcher.enqueue({
    id: "blocker",
    key: "x",
    run: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push("blocker");
    },
  });
  const low = dispatcher.enqueue({
    id: "low",
    key: "y",
    priority: 9,
    run: async () => {
      order.push("low");
    },
  });
  const high = dispatcher.enqueue({
    id: "high",
    key: "z",
    priority: 1,
    run: async () => {
      order.push("high");
    },
  });
  await Promise.all([first, low, high]);
  assert.deepEqual(order, ["blocker", "high", "low"]);
});

test("queue full is rejected", async () => {
  const dispatcher = create({ concurrency: 1, maxQueue: 1 });
  const first = dispatcher.enqueue({
    id: "first",
    key: "a",
    run: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
  });
  const second = dispatcher.enqueue({
    id: "second",
    key: "b",
    run: async () => {},
  });
  await assert.rejects(
    dispatcher.enqueue({ id: "third", key: "c", run: async () => {} }),
    QueueFullError,
  );
  await Promise.all([first, second]);
});

test("timeout rejects and counts", async () => {
  const dispatcher = create({ concurrency: 1, defaultTimeoutMs: 10 });
  await assert.rejects(
    dispatcher.enqueue({
      id: "slow",
      key: "a",
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      },
    }),
    /timed out/,
  );
  assert.equal(dispatcher.snapshot().timedOut, 1);
});

test("close drains queued jobs and rejects the rest", async () => {
  const dispatcher = create({ concurrency: 1, maxQueue: 10 });
  let ran = 0;
  const first = dispatcher.enqueue({
    id: "first",
    key: "a",
    run: async () => {
      ran++;
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
  });
  const second = dispatcher.enqueue({
    id: "second",
    key: "b",
    run: async () => {
      ran++;
    },
  });
  const closed = assert.rejects(second, /closed/);
  void dispatcher.close(5);
  await first;
  await closed;
  assert.equal(ran, 1);
});
