import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "../src/ledger.ts";
import { disposeDir, factoryErrorCode, makeTempDir } from "./helpers.ts";

test("fresh ledger starts at seq 1 and writes exactly the doc §2 line shape", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const ledger = Ledger.open(join(dir, "ledger.jsonl"));

  const evt = ledger.append({ event: "contract_set", task: "T1", gate: "npm test", artifact: "src/format.ts" });

  assert.deepEqual(evt, { seq: 1, event: "contract_set", task: "T1", gate: "npm test", artifact: "src/format.ts" });
  assert.equal(
    readFileSync(join(dir, "ledger.jsonl"), "utf8"),
    '{"seq":1,"event":"contract_set","task":"T1","gate":"npm test","artifact":"src/format.ts"}\n',
  );
});

test("seq increases monotonically and the file gains one line per event", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const path = join(dir, "ledger.jsonl");
  const ledger = Ledger.open(path);

  ledger.append({ event: "contract_set", task: "T1", gate: "npm test", artifact: "src/format.ts" });
  ledger.append({ event: "done_reported", task: "T1", sha: "a1b2c3d" });
  ledger.append({ event: "gate_started", task: "T1", cmd: "npm test" });
  ledger.append({ event: "gate_finished", task: "T1", exit: 1, verdict: "red", note: "2 tests failed" });
  ledger.append({ event: "report_written", task: "T1", path: "factory/report-T1.md" });

  const seqs = ledger.events.map((e) => e.seq);
  assert.deepEqual(seqs, [1, 2, 3, 4, 5]);
  assert.equal(readFileSync(path, "utf8").trimEnd().split("\n").length, 5);
});

test("reopening continues from the last seq and never rewrites earlier lines", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const path = join(dir, "ledger.jsonl");

  const first = Ledger.open(path);
  first.append({ event: "contract_set", task: "T1", gate: "npm test", artifact: "src/format.ts" });
  first.append({ event: "done_reported", task: "T1", sha: "a1b2c3d" });
  const before = readFileSync(path, "utf8");

  const reopened = Ledger.open(path);
  assert.equal(reopened.events.length, 2);
  const evt = reopened.append({ event: "gate_started", task: "T1", cmd: "npm test" });
  assert.equal(evt.seq, 3);

  const after = readFileSync(path, "utf8");
  assert.ok(after.startsWith(before), "earlier ledger lines must never change");
  assert.equal(after.trimEnd().split("\n").length, 3);
});

test("a garbage line is rejected as corruption, not silently skipped", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const path = join(dir, "ledger.jsonl");
  writeFileSync(path, '{"seq":1,"event":"contract_set"\n');

  assert.throws(() => Ledger.open(path), factoryErrorCode("corrupted-ledger"));
});

test("a seq that does not strictly increase is rejected as corruption", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const path = join(dir, "ledger.jsonl");
  writeFileSync(
    path,
    '{"seq":1,"event":"contract_set","task":"T1","gate":"npm test","artifact":"src/format.ts"}\n' +
      '{"seq":1,"event":"done_reported","task":"T1","sha":"a1b2c3d"}\n',
  );

  assert.throws(() => Ledger.open(path), factoryErrorCode("corrupted-ledger"));
});

test("a blank line in the middle is rejected as corruption", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const path = join(dir, "ledger.jsonl");
  writeFileSync(
    path,
    '{"seq":1,"event":"contract_set","task":"T1","gate":"npm test","artifact":"src/format.ts"}\n\n' +
      '{"seq":2,"event":"done_reported","task":"T1","sha":"a1b2c3d"}\n',
  );

  assert.throws(() => Ledger.open(path), factoryErrorCode("corrupted-ledger"));
});

test("an unknown event name is rejected as corruption", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const path = join(dir, "ledger.jsonl");
  writeFileSync(path, '{"seq":1,"event":"gate_was_green","task":"T1"}\n');

  assert.throws(() => Ledger.open(path), factoryErrorCode("corrupted-ledger"));
});

test("open creates the parent directory and tolerates a missing file", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const nested = join(dir, "deep", "state");
  const ledger = Ledger.open(join(nested, "ledger.jsonl"));

  assert.deepEqual([...ledger.events], []);
  ledger.append({ event: "done_reported", task: "T1", sha: "a1b2c3d" });
  assert.equal(readFileSync(join(nested, "ledger.jsonl"), "utf8").trimEnd().split("\n").length, 1);
});

test("eventsFor filters by task across event kinds", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const ledger = Ledger.open(join(dir, "ledger.jsonl"));
  ledger.append({ event: "contract_set", task: "T1", gate: "npm test", artifact: "src/format.ts" });
  ledger.append({ event: "contract_set", task: "T2", gate: "npm test", artifact: "src/other.ts" });
  ledger.append({ event: "done_reported", task: "T1", sha: "a1b2c3d" });

  assert.deepEqual(ledger.eventsFor("T1").map((e) => e.event), ["contract_set", "done_reported"]);
});
