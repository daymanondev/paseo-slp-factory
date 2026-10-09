import { test } from "node:test";
import assert from "node:assert/strict";
import { initials } from "../src/text.ts";

test("initials cover every part of a full name", () => {
  assert.equal(initials("ada lovelace"), "AL");
});
