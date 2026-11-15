import assert from "node:assert/strict";
import test from "node:test";
import { ATME_ADDONS } from "../src/setup/device-flow.js";

test("bot addons include bot capability, scopes, events and card callback", () => {
  assert.equal(ATME_ADDONS.preset, false);
  assert.ok(ATME_ADDONS.scopes.tenant.includes("im:message:send_as_bot"));
  assert.ok(ATME_ADDONS.scopes.tenant.includes("im:message.group_at_msg:readonly"));
  assert.ok(ATME_ADDONS.scopes.tenant.includes("im:message.group_msg"));
  assert.ok(ATME_ADDONS.events.items.tenant.includes("im.message.receive_v1"));
  assert.ok(ATME_ADDONS.callbacks.items.includes("card.action.trigger"));
});
