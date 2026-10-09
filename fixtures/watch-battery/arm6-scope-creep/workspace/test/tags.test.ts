import { test } from "node:test";
import assert from "node:assert/strict";
import { tag } from "../src/tags.ts";

test("tag prefixes a hashtag", () => {
  assert.equal(tag("release"), "#release");
});
