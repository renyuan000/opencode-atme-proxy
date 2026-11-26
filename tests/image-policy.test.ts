import assert from "node:assert/strict";
import test from "node:test";
import { decideImageAttachment, stripEmbeddedOcr } from "../src/core/image-policy.js";

test("uses OCR when it is sufficient", () => {
  const decision = decideImageAttachment(
    "这个问题怎么处理？",
    '"code":"0" 配置快照 告警策略 下行速率 大于 20Kbps',
  );
  assert.equal(decision.attach, false);
  assert.equal(decision.reason, "ocr_sufficient");
});

test("attaches image when OCR is missing or weak", () => {
  assert.equal(decideImageAttachment("看下", "").attach, true);
  assert.equal(decideImageAttachment("看下", "图片").reason, "ocr_missing_or_weak");
  assert.equal(decideImageAttachment("看下", "。。。,,,").reason, "ocr_missing_or_weak");
});

test("attaches image for visual questions", () => {
  const ocr = "配置快照 告警策略 下行速率 大于 20Kbps 间隔一分钟";
  assert.equal(decideImageAttachment("图里的箭头指向哪里？", ocr).reason, "visual_question");
  assert.equal(decideImageAttachment("这个界面颜色对吗？", ocr).attach, true);
});

test("strips embedded OCR from task excerpts", () => {
  assert.equal(
    stripEmbeddedOcr("你看呢[图片]\n\n[图片 OCR，仅作文字参考]\n配置内容"),
    "你看呢[图片]",
  );
  assert.equal(stripEmbeddedOcr("普通消息"), "普通消息");
});
