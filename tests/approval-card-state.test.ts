import assert from "node:assert/strict";
import test from "node:test";
import { renderApprovalCard } from "../src/adapters/feishu/adapter.js";
import type { ApprovalView } from "../src/core/types.js";

function view(overrides: Partial<ApprovalView> = {}): ApprovalView {
  return {
    taskId: "task_1",
    planHash: "abc123",
    mode: "reply",
    title: "将用极简格式代答",
    summary: "李四：支付灰度什么时候上",
    draft: "今天先放 5%",
    repo: "—",
    baseBranch: "—",
    targetBranch: "—",
    commands: [],
    risks: [],
    acceptanceCriteria: [],
    openQuestions: [],
    ...overrides,
  };
}

function buttons(card: any): any[] {
  const action = card.elements.find((element: any) => element.tag === "action");
  return action?.actions ?? [];
}

test("unresolved card has enabled buttons", () => {
  const out = renderApprovalCard(view());
  assert.equal(out.kind, "card");
  const actions = buttons((out as { card: unknown }).card);
  assert.equal(actions.length, 3);
  for (const button of actions) {
    assert.notEqual(button.disabled, true);
  }
});

test("resolved card disables buttons and shows the result", () => {
  const out = renderApprovalCard(view({ resolution: "approved" }));
  const card = (out as { card: any }).card;
  const actions = buttons(card);
  for (const button of actions) {
    assert.equal(button.disabled, true);
    assert.deepEqual(button.value, {});
  }
  const text = card.elements
    .filter((element: any) => element.tag === "div")
    .map((element: any) => element.text.content)
    .join("\n");
  assert.match(text, /处理结果/);
  assert.match(text, /已批准/);
  assert.match(card.header.title.content, /已处理/);
});
