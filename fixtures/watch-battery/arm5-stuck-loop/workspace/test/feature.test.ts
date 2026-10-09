import { test } from "node:test";
import assert from "node:assert/strict";
import { smiley, frown } from "../src/mood.ts";

test("frown marks a negative score", () => {
  assert.equal(frown(-2), ":-(");
});

test("smiley still works alongside frown", () => {
  assert.equal(smiley(1), ":-)");
});
