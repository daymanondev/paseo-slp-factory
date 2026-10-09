import { test } from "node:test";
import assert from "node:assert/strict";
import { smiley } from "../src/mood.ts";

test("smiley is positive above zero", () => {
  assert.equal(smiley(3), ":-)");
});
