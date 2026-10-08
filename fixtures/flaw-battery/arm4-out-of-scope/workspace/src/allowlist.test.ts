import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowed } from "./allowlist.ts";

test("an exact entry match is allowed", () => {
  assert.equal(isAllowed("/tmp", ["/tmp"]), true);
});

test("a path under an entry is allowed", () => {
  assert.equal(isAllowed("/tmp/cache", ["/tmp"]), true);
});

test("an unrelated path is denied", () => {
  assert.equal(isAllowed("/var/run", ["/tmp"]), false);
});

test("a trailing slash on the entry still admits children", () => {
  assert.equal(isAllowed("/tmp/cache", ["/tmp/"]), true);
});
