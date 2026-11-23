import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "../src/core/session-manager.js";
import { SessionStore } from "../src/core/session-store.js";

test("session keys move to a new epoch without reusing old workers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-epoch-"));
  try {
    const sessions = new SessionStore(join(dir, "sessions.json"));
    await sessions.load();
    let epoch = 1;
    const created: Array<{ id: string; title: string; parentID?: string }> = [];
    const logger = {
      info() {},
      warn() {},
      error() {},
      child() {
        return this;
      },
    };
    const manager = new SessionManager({
      bridge: {
        createSession: async (input: { title: string; parentID?: string }) => {
          const id = `s${created.length + 1}`;
          created.push({ id, title: input.title, ...(input.parentID ? { parentID: input.parentID } : {}) });
          return id;
        },
        prompt: async () => "ok",
        deleteSession: async () => {},
      } as never,
      sessions,
      config: {
        opencode: { sessionTitlePrefix: "atme", keepSessions: true },
        subagents: { enabled: true, analyst: "analyst", reviewer: "reviewer" },
      } as never,
      logger: logger as never,
      readOnlyPermission: [],
      epochFor: () => epoch,
    });

    await manager.createWorkerSession({
      platform: "feishu",
      chatId: "chat",
      directory: "/repo",
      title: "worker",
      role: "reply",
    });
    epoch = 2;
    await manager.createWorkerSession({
      platform: "feishu",
      chatId: "chat",
      directory: "/repo",
      title: "worker",
      role: "reply",
    });

    await manager.createWorkerSession({
      platform: "feishu",
      chatId: "chat",
      directory: "/repo",
      title: "worker",
      role: "reply",
      conversationId: "feishu:cli_a:group:chat",
    });

    assert.equal(created.length, 6);
    assert.ok(sessions.list().some(([key]) => key.startsWith("coordinator:feishu:chat:e1")));
    assert.ok(sessions.list().some(([key]) => key.startsWith("coordinator:feishu:chat:e2")));
    assert.ok(sessions.list().some(([key]) => key.startsWith("worker:reply:feishu:chat:e1")));
    assert.ok(sessions.list().some(([key]) => key.startsWith("worker:reply:feishu:chat:e2")));
    assert.ok(
      sessions
        .list()
        .some(([key]) => key.startsWith("worker:reply:feishu:cli_a:group:chat:e2")),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session store preserves group and worker kinds after reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-session-kinds-"));
  try {
    const file = join(dir, "sessions.json");
    const store = new SessionStore(file);
    await store.load();
    store.set("group:feishu:chat", "group-1", "/repo", { kind: "group", chatId: "chat" });
    store.set("worker:reply:feishu:chat", "worker-1", "/repo", {
      kind: "worker",
      chatId: "chat",
    });
    store.set("coordinator:feishu:chat", "coord-1", "/repo", {
      kind: "coordinator",
      chatId: "chat",
    });
    await store.flush();

    const reloaded = new SessionStore(file);
    await reloaded.load();
    assert.equal(reloaded.get("group:feishu:chat")?.kind, "group");
    assert.equal(reloaded.get("worker:reply:feishu:chat")?.kind, "worker");
    assert.equal(reloaded.get("coordinator:feishu:chat")?.kind, "coordinator");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
