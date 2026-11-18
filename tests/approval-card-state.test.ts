import assert from "node:assert/strict";
import test from "node:test";
import { renderApprovalCard, renderCancelConfirmCard, renderReplyManagementCard } from "../src/adapters/feishu/adapter.js";
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
  assert.equal(actions.length, 4);
  for (const button of actions) {
    assert.notEqual(button.disabled, true);
  }
});

test("develop card also exposes reply management", () => {
  const out = renderApprovalCard(view({ mode: "develop" }));
  const card = (out as { card: any }).card;
  const actions = buttons(card);
  assert.equal(actions.at(-1)?.value?.a, "reply_manage");
});

test("reply management card shows recallable reply data", () => {
  const out = renderReplyManagementCard({
    pending: [
      {
        taskId: "task_1",
        planHash: "h1",
        chatLabel: "产品群",
        senderLabel: "李四",
        draft: "草稿",
        excerpt: "原消息",
        createdAt: Date.now(),
      },
    ],
    sent: [
      {
        id: "sent_1",
        chatLabel: "产品群",
        senderLabel: "李四",
        text: "今天先放 5%",
        sourceText: "灰度什么时候上",
        sentAt: Date.now(),
        status: "sent",
      },
    ],
  });
  assert.equal(out.kind, "card");
  const text = JSON.stringify((out as { card: unknown }).card);
  assert.match(text, /产品群/);
  assert.match(text, /李四/);
  assert.match(text, /今天先放 5%/);
  assert.match(text, /撤回此回复/);
  assert.match(text, /recall_reply/);
  assert.match(text, /返回审批/);
});

test("cancel confirmation can return to approval", () => {
  const out = renderCancelConfirmCard({
    taskId: "task_1",
    planHash: "h1",
    draft: "旧草稿",
  });
  const text = JSON.stringify((out as { card: unknown }).card);
  assert.match(text, /cancel_pending_confirm/);
  assert.match(text, /restore_approval/);
  assert.match(text, /旧草稿/);
});

test("resolved card disables buttons and shows the result", () => {
  const out = renderApprovalCard(view({ resolution: "approved" }));
  const card = (out as { card: any }).card;
  const actions = buttons(card);
  for (const button of actions.slice(0, 3)) {
    assert.equal(button.disabled, true);
    assert.deepEqual(button.value, {});
  }
  assert.equal(actions[3]?.value?.a, "reply_manage");
  const text = card.elements
    .filter((element: any) => element.tag === "div")
    .map((element: any) => element.text.content)
    .join("\n");
  assert.match(text, /处理结果/);
  assert.match(text, /已批准/);
  assert.match(card.header.title.content, /已处理/);
});
