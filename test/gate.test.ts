import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runGate } from "../src/gate.ts";
import { REPORT_NOTE_MAX_CHARS, STDOUT_TAIL_CAP_BYTES } from "../src/constants.ts";
import { disposeDir, makeTempDir } from "./helpers.ts";

test("exit 0 with the artifact present is green", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  writeFileSync(join(dir, "out.txt"), "artifact\n");

  const result = await runGate({ cmd: "true", cwd: dir, artifact: "out.txt" });

  assert.equal(result.exit, 0);
  assert.equal(result.verdict, "green");
  assert.equal(result.timedOut, false);
});

test("non-zero exit is red and the note squashes the stdout tail into one line", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  writeFileSync(join(dir, "out.txt"), "artifact\n");

  const result = await runGate({ cmd: "echo one; echo two; exit 3", cwd: dir, artifact: "out.txt" });

  assert.equal(result.exit, 3);
  assert.equal(result.verdict, "red");
  assert.equal(result.note, "one two");
});

test("exit 0 with a missing artifact is red — the artifact is part of the contract", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);

  const result = await runGate({ cmd: "true", cwd: dir, artifact: "nope.txt" });

  assert.equal(result.exit, 0);
  assert.equal(result.verdict, "red");
  assert.match(result.note, /artifact .*nope\.txt.* not found/);
});

test("note falls back to stderr when stdout is empty", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);

  const result = await runGate({ cmd: "echo err-marker 1>&2; exit 1", cwd: dir });

  assert.equal(result.verdict, "red");
  assert.match(result.note, /err-marker/);
});

test("output is capped: only the tail is kept, note stays under the cap", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);

  const result = await runGate({ cmd: "for i in $(seq 1 20000); do echo \"line-$i\"; done; exit 1", cwd: dir });

  assert.equal(result.verdict, "red");
  assert.ok(result.note.length <= REPORT_NOTE_MAX_CHARS, `note was ${result.note.length} chars`);
  assert.match(result.note, /line-20000/, "the tail keeps the end of the output");
  assert.doesNotMatch(result.note, /line-1\b.*line-10000/, "old output must be dropped");
  assert.ok(STDOUT_TAIL_CAP_BYTES > 0);
});

test("timeout kills the gate and records red with exit null", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);

  const result = await runGate({ cmd: "sleep 30", cwd: dir, timeoutMs: 250 });

  assert.equal(result.timedOut, true);
  assert.equal(result.exit, null);
  assert.equal(result.verdict, "red");
  assert.match(result.note, /timeout/i);
});

test("spawn failure in a bad cwd rejects instead of inventing a verdict", async () => {
  await assert.rejects(() => runGate({ cmd: "true", cwd: "/nonexistent-cwd-xyz" }));
});
