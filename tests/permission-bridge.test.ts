import assert from "node:assert/strict";
import test from "node:test";
import { PermissionBridge } from "../src/core/permission-bridge.js";
import type { OpenCodeBridge } from "../src/core/opencode.js";
import type { PermissionView } from "../src/core/types.js";

test("permission bridge does not render the same pending request twice", async () => {
  const cards: PermissionView[] = [];
  let releaseStream: (() => void) | undefined;
  const streamReady = new Promise<void>((resolve) => {
    releaseStream = resolve;
  });
  const bridge = {
    getClient: () => ({
      permission: {
        list: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { data: [{ id: "perm_1", permission: "bash", patterns: ["*"], sessionID: "ses_1" }] };
        },
      },
      event: {
        subscribe: async () => ({
          stream: (async function* () {
            await streamReady;
            yield {
              type: "permission.asked",
              data: { id: "perm_1", permission: "bash", patterns: ["*"], sessionID: "ses_1" },
            };
            await new Promise(() => {});
          })(),
        }),
      },
    }),
  } as unknown as OpenCodeBridge;
  const permissionBridge = new PermissionBridge({
    bridge,
    sendToOwner: async () => true,
    sendPermissionCard: async (view) => {
      cards.push(view);
      return true;
    },
    logger: { warn: () => {}, debug: () => {} } as never,
  });
  await permissionBridge.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  releaseStream?.();
  await new Promise((resolve) => setTimeout(resolve, 30));
  permissionBridge.stop();
  assert.equal(cards.length, 1);
});
