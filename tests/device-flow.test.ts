import assert from "node:assert/strict";
import test from "node:test";
import {
  beginAppRegistration,
  formatRegistrationPrompt,
  parseBeginResponse,
  parsePollResponse,
  pollAppRegistration,
} from "../src/setup/device-flow.js";

test("parseBeginResponse builds verification link", () => {
  const begin = parseBeginResponse({
    device_code: "dc",
    user_code: "ABCD",
    verification_uri: "https://example",
    expires_in: 300,
    interval: 5,
  });
  assert.equal(begin.deviceCode, "dc");
  assert.equal(begin.userCode, "ABCD");
  assert.match(begin.verificationUriComplete, /user_code=ABCD/);
  assert.match(formatRegistrationPrompt(begin), /确认码：ABCD/);
});

test("parsePollResponse handles pending and success", () => {
  assert.equal(parsePollResponse({ error: "authorization_pending" }), undefined);
  const result = parsePollResponse({
    client_id: "cli_x",
    client_secret: "secret",
    user_info: { open_id: "ou_me", tenant_brand: "feishu" },
  });
  assert.equal(result?.appId, "cli_x");
  assert.equal(result?.openId, "ou_me");
});

test("beginAppRegistration posts the expected form", async () => {
  let body = "";
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = String(init?.body ?? "");
    return new Response(JSON.stringify({ device_code: "dc", user_code: "UC" }), {
      status: 200,
    });
  }) as typeof fetch;
  const begin = await beginAppRegistration({ fetchImpl });
  assert.match(body, /action=begin/);
  assert.match(body, /archetype=PersonalAgent/);
  assert.equal(begin.userCode, "UC");
});

test("pollAppRegistration waits through pending then succeeds", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: "authorization_pending" }), { status: 200 });
    }
    return new Response(
      JSON.stringify({ client_id: "cli_x", client_secret: "s" }),
      { status: 200 },
    );
  }) as typeof fetch;
  const result = await pollAppRegistration(
    {
      deviceCode: "dc",
      userCode: "UC",
      verificationUri: "",
      verificationUriComplete: "",
      expiresIn: 60,
      interval: 1,
    },
    { fetchImpl, sleep: async () => {} },
  );
  assert.equal(result.appId, "cli_x");
  assert.equal(calls, 2);
});

test("pollAppRegistration rejects on access_denied", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ error: "access_denied" }), { status: 200 })) as typeof fetch;
  await assert.rejects(
    pollAppRegistration(
      {
        deviceCode: "dc",
        userCode: "UC",
        verificationUri: "",
        verificationUriComplete: "",
        expiresIn: 60,
        interval: 1,
      },
      { fetchImpl, sleep: async () => {} },
    ),
    /取消/,
  );
});
