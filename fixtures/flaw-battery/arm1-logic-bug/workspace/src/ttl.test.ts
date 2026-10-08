import { test } from "node:test";
import assert from "node:assert/strict";
import { isFresh } from "./ttl.ts";

test("an entry well inside the window is fresh", () => {
  assert.equal(isFresh(1000, 200, 5000), true);
});

test("an entry far past the window is expired", () => {
  assert.equal(isFresh(10000, 1000, 5000), false);
});

test("an entry one millisecond inside the boundary is fresh", () => {
  assert.equal(isFresh(5999, 1000, 5000), true);
});

test("an entry one millisecond past the boundary is expired", () => {
  assert.equal(isFresh(6001, 1000, 5000), false);
});

test("an entry written in the future is fresh", () => {
  assert.equal(isFresh(100, 200, 5000), true);
});
