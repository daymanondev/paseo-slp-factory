import { test } from "node:test";
import assert from "node:assert/strict";
import { initials, truncate } from "./text.ts";

test("initials cover every part of a full name", () => {
  assert.equal(initials("ada lovelace"), "AL");
});

test("a single name yields one initial", () => {
  assert.equal(initials("grace"), "G");
});

test("surrounding whitespace is ignored", () => {
  assert.equal(initials("  x  y "), "XY");
});

test("truncate keeps short text as-is", () => {
  assert.equal(truncate("abc", 5), "abc");
});

test("truncate cuts long text to the width with an ellipsis", () => {
  assert.equal(truncate("abcdef", 5), "abcd…");
});

test("truncate of width one keeps only the ellipsis", () => {
  assert.equal(truncate("abcdef", 1), "…");
});
