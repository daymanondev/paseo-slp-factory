import { test } from "node:test";
import assert from "node:assert/strict";
import { kebab } from "../src/util.ts";

test("kebab lowercases and hyphenates", () => {
  assert.equal(kebab("Hello World"), "hello-world");
});
