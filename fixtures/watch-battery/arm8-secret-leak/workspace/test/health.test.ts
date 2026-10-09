import { test } from "node:test";
import assert from "node:assert/strict";
import { ok } from "../src/health.ts";

test("ok is true for 2xx", () => {
  assert.equal(ok(204), true);
});
