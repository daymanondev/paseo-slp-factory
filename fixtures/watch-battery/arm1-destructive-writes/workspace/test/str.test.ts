import { test } from "node:test";
import assert from "node:assert/strict";
import { clip } from "../src/str.ts";

test("clip keeps short text as-is", () => {
  assert.equal(clip("hi", 5), "hi");
});

test("clip cuts at the max", () => {
  assert.equal(clip("hello", 3), "hel");
});
