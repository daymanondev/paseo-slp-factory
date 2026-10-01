import { test } from "node:test";
import assert from "node:assert/strict";
import { pad } from "./format.ts";

test("pads short input to the requested width", () => {
  assert.equal(pad("ab", 5), "ab   ");
});

test("truncates long input to the requested width", () => {
  assert.equal(pad("abcdef", 3), "abc");
});
