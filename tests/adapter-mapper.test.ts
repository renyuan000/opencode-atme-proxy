import assert from "node:assert/strict";
import test from "node:test";
import { mapFeishuMessage } from "../src/adapters/feishu/adapter.js";

test("maps text message and mentions", () => {
  const mapped = mapFeishuMessage({
    message_id: "om_1",
    chat_id: "oc_1",
    chat_type: "group",
    message_type: "text",
    content: JSON.stringify({ text: "@_user_1 支付灰度什么时候上？" }),
    create_time: "1700000000000",
    mentions: [
      { key: "@_user_1", id: { open_id: "ou_me" }, name: "张三" },
    ],
    sender: { sender_id: { open_id: "ou_li" }, sender_type: "user" },
  });
  assert.ok(mapped);
  assert.equal(mapped.messageId, "om_1");
  assert.equal(mapped.chat.id, "oc_1");
  assert.equal(mapped.sender.id, "ou_li");
  assert.equal(mapped.mentions[0]?.id, "ou_me");
  assert.match(mapped.text, /@张三/);
});

test("non-text message becomes placeholder", () => {
  const mapped = mapFeishuMessage({
    message_id: "om_2",
    chat_id: "oc_1",
    chat_type: "group",
    message_type: "image",
    content: JSON.stringify({ image_key: "img" }),
    create_time: "1700000000000",
    sender: { sender_id: { open_id: "ou_li" }, sender_type: "user" },
  });
  assert.equal(mapped?.text, "[图片]");
  assert.equal(mapped?.attachments?.[0]?.kind, "image");
});

test("p2p chat maps to direct", () => {
  const mapped = mapFeishuMessage({
    message_id: "om_3",
    chat_id: "oc_2",
    chat_type: "p2p",
    message_type: "text",
    content: JSON.stringify({ text: "hi" }),
    create_time: "1700000000000",
    sender: { sender_id: { open_id: "ou_li" }, sender_type: "user" },
  });
  assert.equal(mapped?.chat.kind, "direct");
});

test("bot sender is normalized", () => {
  const mapped = mapFeishuMessage({
    message_id: "om_4",
    chat_id: "oc_1",
    chat_type: "group",
    message_type: "text",
    content: JSON.stringify({ text: "bot" }),
    create_time: "1700000000000",
    sender: { sender_id: { open_id: "ou_bot" }, sender_type: "app" },
  });
  assert.equal(mapped?.senderType, "bot");
});
