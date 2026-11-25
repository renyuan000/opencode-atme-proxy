import assert from "node:assert/strict";
import test from "node:test";
import { hammingDistance } from "../src/core/image-fingerprint.js";

test("computes hamming distance for perceptual hashes", () => {
  assert.equal(hammingDistance("0000000000000000", "0000000000000000"), 0);
  assert.equal(hammingDistance("0000000000000000", "0000000000000001"), 1);
  assert.equal(hammingDistance("ffffffffffffffff", "0000000000000000"), 64);
  assert.equal(hammingDistance("abc", "abcd"), Number.POSITIVE_INFINITY);
});
