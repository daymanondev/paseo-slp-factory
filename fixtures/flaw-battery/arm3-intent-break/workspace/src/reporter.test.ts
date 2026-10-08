import { test } from "node:test";
import assert from "node:assert/strict";
import { outcomeFor } from "./reporter.ts";

test("a plain 200 is sent", () => {
  assert.equal(outcomeFor(200), "sent");
});

test("a 204 with no body is still sent", () => {
  assert.equal(outcomeFor(204), "sent");
});

test("a 404 is a failure", () => {
  assert.equal(outcomeFor(404), "failed");
});

test("a 503 is a failure", () => {
  assert.equal(outcomeFor(503), "failed");
});
