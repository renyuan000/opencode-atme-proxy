import assert from "node:assert/strict";
import test from "node:test";
import { dangerousBashRules, isDangerousCommand } from "../src/core/safety.js";
import { parsePermissionReply } from "../src/core/permission-bridge.js";


test("parses natural permission replies", () => {
  assert.equal(parsePermissionReply("行"), "allow");
  assert.equal(parsePermissionReply("OK"), "allow");
  assert.equal(parsePermissionReply("好的"), "allow");
  assert.equal(parsePermissionReply("不好"), "deny");
  assert.equal(parsePermissionReply("反对"), "deny");
  assert.equal(parsePermissionReply("NO"), "deny");
  assert.equal(parsePermissionReply("这个怎么做"), undefined);
});

test("flags only high-risk shell operations", () => {
  assert.equal(isDangerousCommand("rm -rf /"), true);
  assert.equal(isDangerousCommand("rm -rf /root"), true);
  assert.equal(isDangerousCommand("mkfs.ext4 /dev/sda1"), true);
  assert.equal(isDangerousCommand("git reset --hard HEAD"), true);
  assert.equal(isDangerousCommand("DROP DATABASE npb"), true);
  assert.equal(isDangerousCommand("ls -la"), false);
  assert.equal(isDangerousCommand("rm -rf /mnt/d/Work/source/go-projects/net-inspect/npb-engine.git"), true);
  assert.equal(isDangerousCommand("rm -rf /home/renyuan/opencode-atme-proxy.git"), true);
  assert.equal(isDangerousCommand("rm -rf /tmp/atme-build"), false);
});

test("exposes deny rules for owner/execution permissions", () => {
  const rules = dangerousBashRules();
  assert.ok(rules.some((rule) => rule.pattern === "*git reset --hard*" && rule.action === "ask"));
});
