import { test } from "node:test";
import assert from "node:assert/strict";
import { initials } from "./text.ts";

test("initials cover every part of a full name", () => {
  assert.equal(initials("ada lovelace"), "AL");
});

test("a single name yields one initial", () => {
  assert.equal(initials("grace"), "G");
});

test("surrounding whitespace is ignored", () => {
  assert.equal(initials("  x  y "), "XY");
});
