import assert from "node:assert/strict";
import test from "node:test";
import type { AppConfig } from "../src/core/config.js";
import { TaskService } from "../src/core/task-service.js";
import type { IncomingMessage, NotificationView, TaskRecord } from "../src/core/types.js";

function message(): IncomingMessage {
  return {
    platform: "feishu",
    messageId: "m-candidate",
    chat: { id: "chat", kind: "group" },
    sender: { platform: "feishu", id: "u1" },
    senderType: "user",
    text: "系统日志页合并流分/引擎日志",
    mentions: [],
    createdAt: Date.now(),
    rawType: "text",
  };
}

test("candidate card resolves group and sender and records nudge time", async () => {
  const saved = new Map<string, TaskRecord>();
  let view: NotificationView | undefined;
  const service = new TaskService({
    config: {
      policy: { autoAnalyzeTasks: false },
      filter: { profile: { keywords: [] } },
    } as unknown as AppConfig,
    stateDir: "/tmp",
    tasks: {
      findByDedupKey: () => undefined,
      get: async (taskId: string) => saved.get(taskId),
      list: async () => [...saved.values()],
      save: async (task: TaskRecord) => {
        saved.set(task.id, task);
      },
    } as any,
    audit: { append: async () => undefined } as any,
    contextService: {} as any,
    sessionManager: {} as any,
    logger: { warn() {}, info() {}, error() {}, child() { return this; } } as any,
    readOnlyPermission: [],
    chatLabelFor: async () => "产品-资产测绘",
    senderLabelFor: async () => "张雪",
    resolveProject: async () => ({ worktree: "/tmp", resolved: true }),
    projectId: () => undefined,
    memory: {} as any,
    startAnalysis: () => {},
    sendToApprover: async () => true,
    sendOwnerNotification: async (input) => {
      view = input;
      return true;
    },
    sendApproval: async () => {},
  });

  const task = await service.ensureTask(message(), undefined, "group_scan", {
    autoAnalyze: false,
  });
  assert.ok(task);
  assert.equal(task.chatName, "产品-资产测绘");
  assert.equal(task.requester.displayName, "张雪");
  assert.ok(task.lastNudgeAt);
  assert.ok(view);
  assert.equal(view.title, "候选任务 · 产品-资产测绘");
  assert.match(view.headerMeta?.right ?? "", /张雪 · task/);
  assert.equal(saved.get(task.id)?.chatName, "产品-资产测绘");
});
