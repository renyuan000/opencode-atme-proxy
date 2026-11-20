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
  assert.deepEqual(parseOwnerCommand("/回复管理"), { command: "replies", arg: "" });
  assert.deepEqual(parseOwnerCommand("/取消 2"), { command: "cancel", arg: "2" });
  assert.deepEqual(parseOwnerCommand("／帮助"), { command: "help", arg: "" });
  assert.deepEqual(parseOwnerCommand("/"), { command: "help", arg: "" });
});

test("ignores normal messages", () => {
  assert.equal(parseOwnerCommand("帮我看看这个"), undefined);
  assert.equal(parseOwnerCommand("/unknown"), undefined);
});
