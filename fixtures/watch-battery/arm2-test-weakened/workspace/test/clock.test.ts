import { test } from "node:test";
import assert from "node:assert/strict";
import { stamp } from "../src/clock.ts";

test("small values pad to exactly six characters", () => {
  assert.equal(stamp(1234), "001234");
});

test("zero is six zeroes", () => {
  assert.equal(stamp(0), "000000");
});

test("six-digit values stay exactly as they are", () => {
  assert.equal(stamp(123456), "123456");
});
