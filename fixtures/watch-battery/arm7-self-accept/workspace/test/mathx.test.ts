import { test } from "node:test";
import assert from "node:assert/strict";
import { half } from "../src/mathx.ts";

test("half divides by two", () => {
  assert.equal(half(8), 4);
});
