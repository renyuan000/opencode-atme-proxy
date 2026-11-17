import assert from "node:assert/strict";
import test from "node:test";
import { redactPreview } from "../src/core/util.js";

test("masks obvious credentials in previews", () => {
  const preview = redactPreview("api_key=sk-abc123456 password=123456 正常内容");
  assert.ok(!preview.includes("sk-abc123456"));
  assert.ok(!preview.includes("123456"));
  assert.ok(preview.includes("正常内容"));
});

test("keeps normal text and truncates to 80 chars", () => {
  const text = "正常消息".repeat(30);
  const preview = redactPreview(text);
  assert.ok(preview.startsWith("正常消息"));
  assert.ok(preview.length <= 81);
});
