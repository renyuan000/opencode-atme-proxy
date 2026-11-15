import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DedupStore } from "../src/core/dedup.js";

test("dedup persists and survives reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-dedup-"));
  try {
    const file = join(dir, "dedup.json");
    const first = new DedupStore({ file, ttlMs: 60_000, maxEntries: 100 });
    await first.load();
    assert.equal(first.has("a"), false);
    first.add("a");
    await first.flush();
    const second = new DedupStore({ file, ttlMs: 60_000, maxEntries: 100 });
    await second.load();
    assert.equal(second.has("a"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("dedup expires entries by ttl", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-dedup-"));
  try {
    let now = 1000;
    const file = join(dir, "dedup.json");
    const store = new DedupStore({
      file,
      ttlMs: 1000,
      maxEntries: 100,
      now: () => now,
    });
    await store.load();
    store.add("a");
    now = 1500;
    assert.equal(store.has("a"), true);
    now = 2501;
    assert.equal(store.has("a"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("dedup caps entries and evicts oldest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-dedup-"));
  try {
    let now = 1;
    const store = new DedupStore({
      file: join(dir, "dedup.json"),
      ttlMs: 1_000_000,
      maxEntries: 3,
      now: () => now++,
    });
    await store.load();
    store.add("a");
    store.add("b");
    store.add("c");
    store.add("d");
    assert.equal(store.size(), 3);
    assert.equal(store.has("a"), false);
    assert.equal(store.has("d"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
