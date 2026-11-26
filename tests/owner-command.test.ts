import assert from "node:assert/strict";
import test from "node:test";
import { parseOwnerCommand } from "../src/core/owner-command.js";

test("parses slash commands", () => {
  assert.deepEqual(parseOwnerCommand("/改写 新内容"), { command: "rewrite", arg: "新内容" });
  assert.deepEqual(parseOwnerCommand("/重写 更简洁一点"), {
    command: "regenerate",
    arg: "更简洁一点",
  });
  assert.deepEqual(parseOwnerCommand("/发送"), { command: "send", arg: "" });
  assert.deepEqual(parseOwnerCommand("/取消"), { command: "cancel", arg: "" });
  assert.deepEqual(parseOwnerCommand("/列表"), { command: "list", arg: "" });
  assert.deepEqual(parseOwnerCommand("/工作空间 产品-资产测绘"), {
    command: "workspace",
    arg: "产品-资产测绘",
  });
  assert.deepEqual(parseOwnerCommand("/工作空间 产品-资产测绘 添加 asd-engine worktrees/asd-engine.git"), {
    command: "workspace",
    arg: "产品-资产测绘 添加 asd-engine worktrees/asd-engine.git",
  });
  assert.deepEqual(parseOwnerCommand("/任务 产品-流分装置 needs_info 10"), {
    command: "tasks",
    arg: "产品-流分装置 needs_info 10",
  });
  assert.deepEqual(parseOwnerCommand("/任务分析 产品-流分装置 needs_info 5"), {
    command: "task_analyze",
    arg: "产品-流分装置 needs_info 5",
  });
  assert.deepEqual(parseOwnerCommand("/任务清理 产品-流分装置 needs_info 90 确认"), {
    command: "task_archive",
    arg: "产品-流分装置 needs_info 90 确认",
  });
  assert.deepEqual(parseOwnerCommand("/允许 perm_123"), {
    command: "permission_allow",
    arg: "perm_123",
  });
  assert.deepEqual(parseOwnerCommand("/拒绝"), {
    command: "permission_deny",
    arg: "",
  });
  assert.deepEqual(parseOwnerCommand("/任务会话 task_123"), {
    command: "task_sessions",
    arg: "task_123",
  });
  assert.deepEqual(parseOwnerCommand("/任务恢复 task_123"), {
    command: "task_restore",
    arg: "task_123",
  });
  assert.deepEqual(parseOwnerCommand("/诊断 产品-流分装置"), {
    command: "diagnose",
    arg: "产品-流分装置",
  });
  assert.deepEqual(parseOwnerCommand("/方向 产品-资产测绘 负责采集与加工链路"), {
    command: "direction",
    arg: "产品-资产测绘 负责采集与加工链路",
  });
  assert.deepEqual(parseOwnerCommand("/关键词 产品-资产测绘 管理面,IP管理"), {
    command: "keywords",
    arg: "产品-资产测绘 管理面,IP管理",
  });
  assert.deepEqual(parseOwnerCommand("/分析 task_123"), {
    command: "analyze",
    arg: "task_123",
  });
  assert.deepEqual(parseOwnerCommand("/群消息 产品-流分装置 告警 20"), {
    command: "group_messages",
    arg: "产品-流分装置 告警 20",
  });
  assert.deepEqual(parseOwnerCommand("/群消息分析 产品-资产测绘 20"), {
    command: "analyze_group",
    arg: "产品-资产测绘 20",
  });
  assert.deepEqual(parseOwnerCommand("/提及 流分 20"), {
    command: "mentions",
    arg: "流分 20",
  });
  assert.deepEqual(parseOwnerCommand("/回复管理"), { command: "replies", arg: "" });
  assert.deepEqual(parseOwnerCommand("/取消 2"), { command: "cancel", arg: "2" });
  assert.deepEqual(parseOwnerCommand("／帮助"), { command: "help", arg: "" });
  assert.deepEqual(parseOwnerCommand("/"), { command: "help", arg: "" });
});

test("ignores normal messages", () => {
  assert.equal(parseOwnerCommand("帮我看看这个"), undefined);
  assert.equal(parseOwnerCommand("/unknown"), undefined);
});
