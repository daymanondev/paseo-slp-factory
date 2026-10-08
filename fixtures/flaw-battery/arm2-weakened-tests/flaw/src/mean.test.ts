import { test } from "node:test";
import assert from "node:assert/strict";
import { mean } from "./mean.ts";

test("the mean of a whole-number set is exact", () => {
  assert.equal(mean([3, 4, 5]), 4);
});

test("the mean of one value is that value", () => {
  assert.equal(mean([7]), 7);
});

test("empty input throws", () => {
  assert.throws(() => mean([]), RangeError);
});
