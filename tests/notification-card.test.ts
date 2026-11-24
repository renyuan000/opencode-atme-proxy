import assert from "node:assert/strict";
import test from "node:test";
import { renderNotificationCard } from "../src/adapters/feishu/adapter.js";
import type { NotificationView } from "../src/core/types.js";

function view(overrides: Partial<NotificationView> = {}): NotificationView {
  return {
    title: "候选任务",
    headerMeta: {
      left: "产品-流分装置",
      right: "2026-11-24 15:18 张雪 · task",
    },
    sections: [
      {
        title: "排查 Kafka 告警数据无新数据",
        meta: "待确认",
        quote: "排查 Kafka 告警数据自 2026-11-23 21:30 后无新数据的问题",
        detail: "暂不自动分析",
      },
    ],
    footer: "如需分析，回复 /分析 task_494985fdf2fd",
    ...overrides,
  };
}

function card(out: ReturnType<typeof renderNotificationCard>): any {
  assert.equal(out.kind, "card");
  return (out as { card: unknown }).card;
}

test("notification card renders group left and time/sender/task right", () => {
  const rendered = card(renderNotificationCard(view()));
  assert.equal(rendered.header.title.content, "候选任务");
  const row = rendered.elements[0];
  assert.equal(row.tag, "column_set");
  assert.equal(row.flex_mode, "stretch");
  assert.equal(row.columns.length, 2);
  assert.equal(row.columns[0].width, "weighted");
  assert.equal(row.columns[0].elements[0].text.content, "产品-流分装置");
  assert.equal(row.columns[1].width, "auto");
  assert.equal(row.columns[1].elements[0].text.content, "2026-11-24 15:18 张雪 · task");
});

test("notification card can right-align group without a left label", () => {
  const rendered = card(
    renderNotificationCard(
      view({
        title: "群消息分析",
        headerMeta: { right: "产品-资产测绘" },
        subtitle: "与你相关 2 条，共 3 条",
      }),
    ),
  );
  assert.equal(rendered.header.title.content, "群消息分析");
  const row = rendered.elements[0];
  assert.equal(row.tag, "column_set");
  assert.equal(row.columns.length, 2);
  assert.equal(row.columns[0].width, "weighted");
  assert.equal(row.columns[1].width, "auto");
  assert.equal(row.columns[1].elements[0].text.content, "产品-资产测绘");
});

test("notification card renders subtitle when present", () => {
  const rendered = card(
    renderNotificationCard(view({ headerMeta: undefined, subtitle: "产品-流分装置 · 本轮 3 条" })),
  );
  assert.equal(rendered.elements[0].tag, "div");
  assert.equal(rendered.elements[0].text.content, "产品-流分装置 · 本轮 3 条");
});


test("notification section renders its own message link", () => {
  const rendered = card(
    renderNotificationCard(
      view({
        headerMeta: undefined,
        sections: [
          {
            title: "消息",
            link: {
              label: "查看原消息",
              url: "https://applink.feishu.cn/client/chat/open?openChatId=chat&position=12",
            },
          },
        ],
      }),
    ),
  );
  const text = rendered.elements[0].text.content as string;
  assert.match(text, /\[查看原消息\]/);
  assert.match(text, /position=12/);
});
