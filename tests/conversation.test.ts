import assert from "node:assert/strict";
import test from "node:test";
import { conversationKey, conversationRefForChat } from "../src/core/conversation.js";

test("conversation key isolates channel, account, kind, and external id", () => {
  assert.equal(
    conversationKey(conversationRefForChat("feishu", "oc_group", "group", "cli_a")),
    "feishu:cli_a:group:oc_group",
  );
  assert.equal(
    conversationKey(conversationRefForChat("feishu", "oc_dm", "dm", "cli_a")),
    "feishu:cli_a:dm:oc_dm",
  );
  assert.notEqual(
    conversationKey(conversationRefForChat("feishu", "oc_dm", "dm", "cli_a")),
    conversationKey(conversationRefForChat("feishu", "oc_dm", "dm", "cli_b")),
  );
  assert.equal(
    conversationKey(conversationRefForChat("wechat", "wxid", "dm", "accountA")),
    "wechat:accountA:dm:wxid",
  );
});
