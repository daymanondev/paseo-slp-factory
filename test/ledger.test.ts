import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "../src/ledger.ts";
import { disposeDir, factoryErrorCode, makeTempDir } from "./helpers.ts";

const contract = { event: "contract_set", task: "T1", workspace: "/tmp/ws", gate: "npm test", artifact: "src/format.ts" } as const;

/** Parses one ledger line and drops the clock-dependent `ts` so asserts stay exact. */
function lineWithoutTs(line: string): Record<string, unknown> {
  const { ts, ...rest } = JSON.parse(line) as { ts?: unknown };
  assert.match(String(ts), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, "ts is an ISO 8601 timestamp (ADR 0003)");
  return rest;
}

test("fresh ledger starts at seq 1, stamps ts, and writes the §2 event shape", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const ledger = Ledger.open(join(dir, "ledger.jsonl"));

  const evt = ledger.append(contract);

  assert.deepEqual({ ...evt, ts: undefined }, { ts: undefined, seq: 1, ...contract });
  assert.deepEqual(lineWithoutTs(readFileSync(join(dir, "ledger.jsonl"), "utf8")), { seq: 1, ...contract });
});

test("seq increases monotonically and the file gains one line per event", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const path = join(dir, "ledger.jsonl");
  const ledger = Ledger.open(path);

  ledger.append(contract);
  ledger.append({ event: "claim_reported", task: "T1", attempt: 1, sha: "a1b2c3d" });
  ledger.append({ event: "gate_started", task: "T1", attempt: 1, cmd: "npm test" });
  ledger.append({ event: "gate_finished", task: "T1", attempt: 1, exit: 1, verdict: "red", note: "2 tests failed" });
  ledger.append({ event: "report_written", task: "T1", attempt: 1, path: "factory/report-T1-1.md" });

  const seqs = ledger.events.map((e) => e.seq);
  assert.deepEqual(seqs, [1, 2, 3, 4, 5]);
  assert.equal(readFileSync(path, "utf8").trimEnd().split("\n").length, 5);
});

test("reopening continues from the last seq and never rewrites earlier lines", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const path = join(dir, "ledger.jsonl");

  const first = Ledger.open(path);
  first.append(contract);
  first.append({ event: "claim_reported", task: "T1", attempt: 1, sha: "a1b2c3d" });
  const before = readFileSync(path, "utf8");

  const reopened = Ledger.open(path);
  assert.equal(reopened.events.length, 2);
  const evt = reopened.append({ event: "gate_started", task: "T1", attempt: 1, cmd: "npm test" });
  assert.equal(evt.seq, 3);

  const after = readFileSync(path, "utf8");
  assert.ok(after.startsWith(before), "earlier ledger lines must never change");
  assert.equal(after.trimEnd().split("\n").length, 3);
});

test("a final line with no trailing newline is quarantined and dropped, not trusted (ADR 0003)", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const path = join(dir, "ledger.jsonl");
  const complete = `${JSON.stringify({ seq: 1, ts: "2026-10-07T10:00:00.000Z", ...contract })}\n`;
  writeFileSync(path, `${complete}{"seq":2,"ts":"2026-10-07T10:00:01.000Z","event":"claim_repor`);

  const ledger = Ledger.open(path);

  assert.equal(ledger.events.length, 1, "the unterminated line is not an event");
  assert.equal(readFileSync(path, "utf8"), complete, "the ledger keeps only complete lines");
  assert.equal(
    readFileSync(`${path}.quarantine`, "utf8"),
    '{"seq":2,"ts":"2026-10-07T10:00:01.000Z","event":"claim_repor\n',
    "the tail is kept verbatim for inspection",
  );
  const next = ledger.append({ event: "claim_reported", task: "T1", attempt: 1, sha: "a1b2c3d" });
  assert.equal(next.seq, 2, "the dropped line's seq is free again — it was never acknowledged");
});

test("a garbage line is rejected as corruption, not silently skipped", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const path = join(dir, "ledger.jsonl");
  writeFileSync(path, '{"seq":1,"ts":"2026-10-07T10:00:00.000Z","event":"contract_set"\n');

  assert.throws(() => Ledger.open(path), factoryErrorCode("corrupted-ledger"));
});

test("a seq that does not strictly increase is rejected as corruption", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const path = join(dir, "ledger.jsonl");
  writeFileSync(
    path,
    `${JSON.stringify({ seq: 1, ts: "2026-10-07T10:00:00.000Z", ...contract })}\n` +
      '{"seq":1,"ts":"2026-10-07T10:00:01.000Z","event":"claim_reported","task":"T1","attempt":1,"sha":"a1b2c3d"}\n',
  );

  assert.throws(() => Ledger.open(path), factoryErrorCode("corrupted-ledger"));
});

test("a blank line in the middle is rejected as corruption", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const path = join(dir, "ledger.jsonl");
  writeFileSync(
    path,
    `${JSON.stringify({ seq: 1, ts: "2026-10-07T10:00:00.000Z", ...contract })}\n\n` +
      '{"seq":2,"ts":"2026-10-07T10:00:01.000Z","event":"claim_reported","task":"T1","attempt":1,"sha":"a1b2c3d"}\n',
  );

  assert.throws(() => Ledger.open(path), factoryErrorCode("corrupted-ledger"));
});

test("an unknown event name is rejected as corruption", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const path = join(dir, "ledger.jsonl");
  writeFileSync(path, '{"seq":1,"ts":"2026-10-07T10:00:00.000Z","event":"gate_was_green","task":"T1"}\n');

  assert.throws(() => Ledger.open(path), factoryErrorCode("corrupted-ledger"));
});

test("a post-contract event without a positive integer attempt is rejected as corruption", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const path = join(dir, "ledger.jsonl");
  writeFileSync(path, '{"seq":1,"ts":"2026-10-07T10:00:00.000Z","event":"claim_reported","task":"T1","sha":"a1b2c3d"}\n');

  assert.throws(() => Ledger.open(path), factoryErrorCode("corrupted-ledger"));
});

test("an event without ts is rejected as corruption", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const path = join(dir, "ledger.jsonl");
  writeFileSync(path, `${JSON.stringify({ seq: 1, ...contract })}\n`);

  assert.throws(() => Ledger.open(path), factoryErrorCode("corrupted-ledger"));
});

test("open creates the parent directory and tolerates a missing file", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const nested = join(dir, "deep", "state");
  const ledger = Ledger.open(join(nested, "ledger.jsonl"));

  assert.deepEqual([...ledger.events], []);
  ledger.append({ event: "claim_reported", task: "T1", attempt: 1, sha: "a1b2c3d" });
  assert.equal(readFileSync(join(nested, "ledger.jsonl"), "utf8").trimEnd().split("\n").length, 1);
});

test("eventsFor filters by task across event kinds", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const ledger = Ledger.open(join(dir, "ledger.jsonl"));
  ledger.append(contract);
  ledger.append({ ...contract, task: "T2" });
  ledger.append({ event: "claim_reported", task: "T1", attempt: 1, sha: "a1b2c3d" });

  assert.deepEqual(ledger.eventsFor("T1").map((e) => e.event), ["contract_set", "claim_reported"]);
});
