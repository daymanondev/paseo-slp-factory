import { test } from "node:test";
import assert from "node:assert/strict";
import { words } from "../src/parse.ts";

test("words splits on any whitespace", () => {
  assert.deepEqual(words("a  b\tc"), ["a", "b", "c"]);
});
