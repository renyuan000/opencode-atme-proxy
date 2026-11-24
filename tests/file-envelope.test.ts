import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { extractDocument } from "../src/core/document.js";
import { createFileEnvelope } from "../src/core/file-envelope.js";

test("extractDocument returns structured truncation metadata", async () => {
  const source = "a".repeat(20_050);
  const result = await extractDocument(Buffer.from(source), "text/plain", "notes.txt");
  assert.equal(result.extractor, "text");
  assert.equal(result.chars, 20_050);
  assert.equal(result.truncated, true);
  assert.equal(result.text?.length, 20_000);
  assert.deepEqual(result.readRanges, [{ kind: "chars", start: 0, end: 20_000 }]);
  assert.deepEqual(result.pagesProcessed, []);
});

test("createFileEnvelope records hash, size and extraction metadata", async () => {
  const data = Buffer.from("hello");
  const extracted = await extractDocument(data, "text/plain", "hello.txt");
  const envelope = createFileEnvelope({
    conversationId: "feishu:app:group:chat",
    data,
    mime: "text/plain",
    name: "hello.txt",
    localPath: "files/abc/hello.txt",
    extracted,
  });
  assert.equal(envelope.conversationId, "feishu:app:group:chat");
  assert.equal(envelope.sha256, createHash("sha256").update(data).digest("hex"));
  assert.equal(envelope.size, 5);
  assert.equal(envelope.mime, "text/plain");
  assert.equal(envelope.name, "hello.txt");
  assert.equal(envelope.localPath, "files/abc/hello.txt");
  assert.equal(envelope.text, "hello");
  assert.equal(envelope.chars, 5);
  assert.equal(envelope.truncated, false);
});

test("unsupported files return a structured error", async () => {
  const result = await extractDocument(Buffer.from([0, 1, 2]), "application/octet-stream", "x.bin");
  assert.equal(result.error, "unsupported");
  assert.equal(result.extractor, "none");
  assert.equal(result.text, undefined);
  assert.deepEqual(result.readRanges, []);
});
