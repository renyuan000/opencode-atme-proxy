import assert from "node:assert/strict";
import test from "node:test";
import { ProjectResolver, isActiveProject, recencyScore } from "../src/core/project-resolver.js";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";

function client(projects: any[], sessions: any[] = []): OpencodeClient {
  return {
    project: { list: async () => ({ data: projects }) },
    experimental: { session: { list: async () => ({ data: sessions }) } },
  } as unknown as OpencodeClient;
}

const now = Date.now();

test("ignores global/root projects", () => {
  assert.equal(isActiveProject({ id: "g", worktree: "/", vcs: true, updatedAt: now }), false);
  assert.equal(isActiveProject({ id: "h", worktree: "/root", vcs: true, updatedAt: now }), false);
  assert.equal(isActiveProject({ id: "p", worktree: "/repo/a", vcs: true, updatedAt: now }), true);
});

test("picks project with recent sessions", async () => {
  const resolver = new ProjectResolver({
    client: client(
      [
        { id: "a", worktree: "/repo/a", vcs: "git", time: { updated: now - 86400000 } },
        { id: "b", worktree: "/repo/b", vcs: "git", time: { updated: now } },
      ],
      [{ id: "s1", projectID: "a", directory: "/repo/a", time: { updated: now } }],
    ),
    allowlist: [],
    recentSessions: 20,
    maxAgeDays: 30,
  });
  const selection = await resolver.resolve();
  assert.equal(selection?.project.id, "a");
});

test("prefers most recent when no sessions", async () => {
  const resolver = new ProjectResolver({
    client: client([
      { id: "a", worktree: "/repo/a", vcs: "git", time: { updated: now - 86400000 } },
      { id: "b", worktree: "/repo/b", vcs: "git", time: { updated: now } },
    ]),
    allowlist: [],
    recentSessions: 20,
    maxAgeDays: 30,
  });
  const selection = await resolver.resolve();
  assert.equal(selection?.project.id, "b");
});

test("allowlist rejects outside projects", async () => {
  const resolver = new ProjectResolver({
    client: client([
      { id: "a", worktree: "/repo/a", vcs: "git", time: { updated: now } },
      { id: "b", worktree: "/other/b", vcs: "git", time: { updated: now - 1000 } },
    ]),
    allowlist: ["/repo"],
    recentSessions: 20,
    maxAgeDays: 30,
  });
  const selection = await resolver.resolve();
  assert.equal(selection?.project.id, "a");
});

test("explicit worktree wins", async () => {
  const resolver = new ProjectResolver({
    client: client([]),
    allowlist: [],
    explicitWorktree: "/explicit/repo",
  });
  const selection = await resolver.resolve();
  assert.equal(selection?.project.worktree, "/explicit/repo");
});

test("recency score decays", () => {
  assert.ok(recencyScore(now, 30) > recencyScore(now - 86400000 * 10, 30));
  assert.equal(recencyScore(0, 30), 0);
  assert.equal(recencyScore(now - 86400000 * 40, 30), 0);
});
