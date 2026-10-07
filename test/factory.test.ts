import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../src/factory.ts";
import { FactoryError } from "../src/errors.ts";
import { disposeDir, factoryErrorCode, gitCommitAll, makeTempDir } from "./helpers.ts";

function makeWorkspace(dir: string): { workspace: string; artifact: string; sha: string } {
  const workspace = join(dir, "ws");
  mkdirSync(join(workspace, "src"), { recursive: true });
  const artifact = "src/format.ts";
  writeFileSync(join(workspace, artifact), "export function pad() {}\n");
  const sha = gitCommitAll(workspace);
  return { workspace, artifact, sha };
}

test("setContract records the contract and enforces one contract per task", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const factory = createFactory({ stateDir: join(dir, "factory") });

  const evt = factory.setContract({ task: "T1", gate: "npm test", artifact: "src/format.ts" });

  assert.deepEqual(evt, { seq: 1, event: "contract_set", task: "T1", gate: "npm test", artifact: "src/format.ts" });
  assert.throws(
    () => factory.setContract({ task: "T1", gate: "echo easier", artifact: "x.ts" }),
    factoryErrorCode("contract-exists"),
  );
});

test("setContract rejects unusable input instead of writing it to the ledger", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const factory = createFactory({ stateDir: join(dir, "factory") });

  for (const bad of ["", "../evil", "a/b", ".hidden", "task with spaces"]) {
    assert.throws(
      () => factory.setContract({ task: bad, gate: "npm test", artifact: "src/x.ts" }),
      (err: unknown) => err instanceof FactoryError,
      `task id "${bad}" must be rejected`,
    );
  }
  assert.throws(() => factory.setContract({ task: "T1", gate: "  ", artifact: "src/x.ts" }), FactoryError);
  assert.throws(() => factory.setContract({ task: "T1", gate: "npm test", artifact: "" }), FactoryError);
  assert.deepEqual([...factory.ledger.events], [], "rejected input must not touch the ledger");
});

test("claim without a contract fails before anything is appended", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const factory = createFactory({ stateDir: join(dir, "factory") });

  await assert.rejects(factory.claim({ task: "T404", sha: "a1b2c3d" }), factoryErrorCode("unknown-task"));
  assert.deepEqual([...factory.ledger.events], []);
});

test("claim with an unknown sha is a red verdict, never a HEAD fallback", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "factory"), workspace });

  factory.setContract({ task: "U1", gate: "true", artifact });
  const outcome = await factory.claim({ task: "U1", sha: "1234567890123456789012345678901234567890" });

  assert.equal(outcome.verdict, "red");
  assert.equal(outcome.gate.exit, null, "the gate command must not run on an unverified sha");
  assert.match(outcome.gate.note, /cannot be resolved/);
  assert.equal(outcome.gate.sha, undefined);
  assert.deepEqual(
    factory.ledger.eventsFor("U1").map((e) => e.event),
    ["contract_set", "claim_reported", "gate_started", "gate_finished", "report_written"],
  );
});

test("claim with an empty sha is a red verdict, not a thrown error", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "factory"), workspace });

  factory.setContract({ task: "U2", gate: "true", artifact });
  const outcome = await factory.claim({ task: "U2", sha: "   " });

  assert.equal(outcome.verdict, "red");
  assert.match(outcome.gate.note, /claimed sha is empty/);
});

test("claim on a dirty tree is red even though the commit exists", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "factory"), workspace });

  writeFileSync(join(workspace, artifact), "export function pad() { return 1; }\n"); // uncommitted change
  factory.setContract({ task: "D1", gate: "true", artifact });
  const outcome = await factory.claim({ task: "D1", sha });

  assert.equal(outcome.verdict, "red");
  assert.equal(outcome.gate.exit, null);
  assert.match(outcome.gate.note, /not clean at the claimed commit before the gate/);
  assert.equal(outcome.gate.sha, sha, "the sha still resolved, so the verdict records what it attests");
});

test("a gate that moves HEAD during the run is red even when it exits 0", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "factory"), workspace });

  factory.setContract({ task: "M1", gate: "git commit -q --allow-empty -m moved", artifact });
  const outcome = await factory.claim({ task: "M1", sha });

  assert.equal(outcome.verdict, "red");
  assert.equal(outcome.gate.exit, 0, "the command itself succeeded — that is exactly the trap");
  assert.match(outcome.gate.note, /workspace moved during the gate/);
});

test("a claim by short sha attests the full resolved commit", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "factory"), workspace });

  factory.setContract({ task: "S1", gate: "true", artifact });
  const outcome = await factory.claim({ task: "S1", sha: sha.slice(0, 7) });

  assert.equal(outcome.verdict, "green");
  assert.equal(outcome.gate.sha, sha);
  assert.match(sha, /^[0-9a-f]{40}$/);
  const report = readFileSync(outcome.reportPath, "utf8");
  assert.ok(report.includes(`- Attested commit: \`${sha}\``), "the report shows the commit the verdict attests");
});

test("claim red path appends the full event sequence and writes the report", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const stateDir = join(dir, "factory");
  const factory = createFactory({ stateDir, workspace });

  factory.setContract({ task: "T9", gate: "exit 3", artifact });
  const outcome = await factory.claim({ task: "T9", sha });

  assert.equal(outcome.verdict, "red");
  assert.equal(outcome.gate.exit, 3);
  assert.deepEqual(
    factory.ledger.eventsFor("T9").map((e) => e.event),
    ["contract_set", "claim_reported", "gate_started", "gate_finished", "report_written"],
  );
  const report = readFileSync(outcome.reportPath, "utf8");
  assert.match(report, /# T9 — /);
  assert.ok(report.includes("- Verdict: RED —"));
});

test("claim green path when gate passes and artifact exists at the claimed commit", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "factory"), workspace });

  factory.setContract({ task: "T10", gate: "true", artifact });
  const outcome = await factory.claim({ task: "T10", sha });

  assert.equal(outcome.verdict, "green");
  const report = readFileSync(outcome.reportPath, "utf8");
  assert.ok(report.includes("- Verdict: GREEN —"));
  assert.ok(!report.includes("Conclusion"), "the report states evidence, it does not conclude");
  assert.ok(!/\bDONE\b/.test(report), '"done" stays out of the report — green is evidence, not acceptance');
});

test("claim timeout flows through as red with exit null", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "factory"), workspace, timeoutMs: 250 });

  factory.setContract({ task: "T11", gate: "sleep 30", artifact });
  const outcome = await factory.claim({ task: "T11", sha });

  assert.equal(outcome.verdict, "red");
  assert.equal(outcome.gate.exit, null);
  assert.match(outcome.gate.note, /timeout/i);
});

test("a gate command that does not exist is red with the shell's exit code", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "factory"), workspace });

  factory.setContract({ task: "T12", gate: "definitely-not-a-command-xyz", artifact });
  const outcome = await factory.claim({ task: "T12", sha });

  // /bin/sh resolves command-not-found itself and exits 127 — the factory
  // records that fact instead of special-casing it.
  assert.equal(outcome.verdict, "red");
  assert.equal(outcome.gate.exit, 127);
  assert.match(outcome.gate.note, /not found/i);
  assert.deepEqual(
    factory.ledger.eventsFor("T12").map((e) => e.event),
    ["contract_set", "claim_reported", "gate_started", "gate_finished", "report_written"],
  );
});

test("a workspace that is not a git repo is red, not a crash", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "plain");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "format.ts"), "export function pad() {}\n");
  const factory = createFactory({ stateDir: join(dir, "factory"), workspace });

  factory.setContract({ task: "G1", gate: "true", artifact: "src/format.ts" });
  const outcome = await factory.claim({ task: "G1", sha: "a1b2c3d" });

  assert.equal(outcome.verdict, "red");
  assert.match(outcome.gate.note, /cannot be resolved/);
});

test("two tasks share one ledger with independent seq and reports", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const stateDir = join(dir, "factory");
  const factory = createFactory({ stateDir, workspace });

  factory.setContract({ task: "A1", gate: "true", artifact });
  factory.setContract({ task: "A2", gate: "exit 1", artifact });
  const first = await factory.claim({ task: "A1", sha });
  const second = await factory.claim({ task: "A2", sha });

  assert.equal(first.verdict, "green");
  assert.equal(second.verdict, "red");
  assert.deepEqual(factory.ledger.events.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.notEqual(first.reportPath, second.reportPath);
});
