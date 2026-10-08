import { test } from "node:test";
import assert from "node:assert/strict";
import { mean } from "./mean.ts";

test("the mean of a fractional set is exact", () => {
  assert.equal(mean([1, 2, 3, 4]), 2.5);
});

test("the mean of one value is that value", () => {
  assert.equal(mean([7]), 7);
});

test("empty input throws", () => {
  assert.throws(() => mean([]), RangeError);
});
