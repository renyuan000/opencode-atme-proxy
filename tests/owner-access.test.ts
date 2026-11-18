import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuditLog } from "../src/core/audit.js";
import { createLogger } from "../src/core/logger.js";
import { OwnerAccessService } from "../src/core/owner-access-service.js";
import { OwnerStore } from "../src/core/owner-store.js";
import type { IncomingMessage } from "../src/core/types.js";

function message(text: string): IncomingMessage {
  return {
    platform: "feishu",
    messageId: `om_${text}`,
    chat: { id: "dm", kind: "direct" },
    sender: { platform: "feishu", id: "owner", displayName: "Owner" },
    senderType: "user",
    text,
    mentions: [],
    createdAt: Date.now(),
    rawType: "text",
  };
}

function service(stateDir: string, maxAttempts: number) {
  return new OwnerAccessService({
    config: {
      platforms: {
        feishu: {
          me: {},
          approvers: [],
          groups: [],
          bootstrap: {
            allowPrivateClaim: true,
            maxClaimAttemptsPer10Min: maxAttempts,
          },
        },
      },
      filter: { profile: { name: "me" } },
    } as never,
    loaded: { config: {} as never, secrets: { claimCode: "secret" }, path: "" },
    owners: new OwnerStore(join(stateDir, "owner.json")),
    audit: new AuditLog(join(stateDir, "audit.jsonl")),
    logger: createLogger({ scope: "owner-test" }),
    sendToOwner: async () => true,
  });
}

test("owner claim rejects a correct code after too many wrong attempts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-owner-"));
  try {
    const access = service(dir, 1);
    assert.equal(await access.claim(message("wrong-1")), false);
    assert.equal(await access.claim(message("wrong-2")), false);
    assert.equal(await access.claim(message("secret")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("owner claim accepts the correct code within the attempt limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-owner-"));
  try {
    const access = service(dir, 5);
    assert.equal(await access.claim(message("secret")), true);
    assert.equal(access.openId(), "owner");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
