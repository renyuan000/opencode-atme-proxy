import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { extractDocument } from "../src/core/document.js";
import { createFileEnvelope, extractFileEnvelope } from "../src/core/file-envelope.js";
import * as XLSX from "xlsx";

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


test("extracts Excel workbooks", async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["name", "value"],
      ["kafka", "42"],
    ]),
    "资产",
  );
  const data = Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
  const result = await extractDocument(
    data,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "assets.xlsx",
  );
  assert.equal(result.extractor, "xlsx");
  assert.match(result.text ?? "", /### Sheet: 资产/);
  assert.match(result.text ?? "", /kafka,42/);
});

test("enforces optional maxBytes and maxChars", async () => {
  const data = Buffer.from("abcdef");
  const tooLarge = await extractDocument(data, "text/plain", "a.txt", { maxBytes: 3 });
  assert.equal(tooLarge.error, "too_large");
  assert.equal(tooLarge.text, undefined);

  const clipped = await extractFileEnvelope({
    conversationId: "feishu:app:group:chat",
    data,
    mime: "text/plain",
    name: "a.txt",
    options: { maxChars: 3 },
  });
  assert.equal(clipped.text, "abc");
  assert.equal(clipped.chars, 6);
  assert.equal(clipped.truncated, true);
  assert.deepEqual(clipped.readRanges, [{ kind: "chars", start: 0, end: 3 }]);
});
