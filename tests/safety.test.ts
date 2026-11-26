import assert from "node:assert/strict";
import test from "node:test";
import { dangerousBashRules, isDangerousCommand } from "../src/core/safety.js";

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
