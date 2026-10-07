import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../src/factory.ts";
import { FactoryError } from "../src/errors.ts";
import { disposeDir, factoryErrorCode, gitCommitAll, gitCommitChanges, makeTempDir } from "./helpers.ts";

function makeWorkspace(dir: string): { workspace: string; artifact: string; sha: string } {
  const workspace = join(dir, "ws");
  mkdirSync(join(workspace, "src"), { recursive: true });
  const artifact = "src/format.ts";
  writeFileSync(join(workspace, artifact), "export function pad() {}\n");
  const sha = gitCommitAll(workspace);
  return { workspace, artifact, sha };
}

test("setContract records the workspace with the criteria and enforces one contract per task", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, sha } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "factory") });

  const evt = factory.setContract({ task: "T1", workspace, gate: "npm test", artifact: "src/format.ts" });

  const { ts, ...rest } = evt;
  assert.match(ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(rest, {
    seq: 1,
    event: "contract_set",
    task: "T1",
    workspace,
    gate: "npm test",
    artifact: "src/format.ts",
    base: sha, // recorded on every Contract since v0.0.2 (ticket 03 R2)
  });
  assert.throws(
    () => factory.setContract({ task: "T1", workspace, gate: "echo easier", artifact: "x.ts" }),
    factoryErrorCode("contract-exists"),
  );
});

test("setContract rejects a workspace that is not an existing absolute directory", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "factory") });

  for (const bad of ["relative/ws", "/definitely/not/here"]) {
    assert.throws(
      () => factory.setContract({ task: "W1", workspace: bad, gate: "true", artifact: "src/x.ts" }),
      factoryErrorCode("invalid-contract"),
      `workspace "${bad}" must be rejected`,
    );
  }
  assert.throws(
    () => factory.setContract({ task: "W1", workspace: join(workspace, "src", "format.ts"), gate: "true", artifact: "src/x.ts" }),
    factoryErrorCode("invalid-contract"),
    "a file is not a workspace",
  );
  assert.deepEqual([...factory.ledger.events], []);
});

test("setContract rejects unusable input instead of writing it to the ledger", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "factory") });

  for (const bad of ["", "../evil", "a/b", ".hidden", "task with spaces"]) {
    assert.throws(
      () => factory.setContract({ task: bad, workspace, gate: "npm test", artifact: "src/x.ts" }),
      (err: unknown) => err instanceof FactoryError,
      `task id "${bad}" must be rejected`,
    );
  }
  assert.throws(() => factory.setContract({ task: "T1", workspace, gate: "  ", artifact: "src/x.ts" }), FactoryError);
  assert.throws(() => factory.setContract({ task: "T1", workspace, gate: "npm test", artifact: "" }), FactoryError);
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
  const factory = createFactory({ stateDir: join(dir, "factory") });

  factory.setContract({ task: "U1", workspace, gate: "true", artifact });
  const outcome = await factory.claim({ task: "U1", sha: "1234567890123456789012345678901234567890" });

  assert.equal(outcome.verdict, "red");
  assert.equal(outcome.attempt, 1);
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
  const factory = createFactory({ stateDir: join(dir, "factory") });

  factory.setContract({ task: "U2", workspace, gate: "true", artifact });
  const outcome = await factory.claim({ task: "U2", sha: "   " });

  assert.equal(outcome.verdict, "red");
  assert.match(outcome.gate.note, /claimed sha is empty/);
});

test("claim on a dirty tree is red even though the commit exists", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "factory") });

  writeFileSync(join(workspace, artifact), "export function pad() { return 1; }\n"); // uncommitted change
  factory.setContract({ task: "D1", workspace, gate: "true", artifact });
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
  const factory = createFactory({ stateDir: join(dir, "factory") });

  factory.setContract({ task: "M1", workspace, gate: "git commit -q --allow-empty -m moved", artifact });
  const outcome = await factory.claim({ task: "M1", sha });

  assert.equal(outcome.verdict, "red");
  assert.equal(outcome.gate.exit, 0, "the command itself succeeded — that is exactly the trap");
  assert.match(outcome.gate.note, /workspace moved during the gate/);
});

test("a claim by short sha attests the full resolved commit", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "factory") });

  factory.setContract({ task: "S1", workspace, gate: "true", artifact });
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
  const factory = createFactory({ stateDir });

  factory.setContract({ task: "T9", workspace, gate: "exit 3", artifact });
  const outcome = await factory.claim({ task: "T9", sha });

  assert.equal(outcome.verdict, "red");
  assert.equal(outcome.gate.exit, 3);
  assert.deepEqual(
    factory.ledger.eventsFor("T9").map((e) => e.event),
    ["contract_set", "claim_reported", "gate_started", "gate_finished", "report_written"],
  );
  assert.equal(outcome.reportPath, join(stateDir, "report-T9-1.md"));
  const report = readFileSync(outcome.reportPath, "utf8");
  assert.match(report, /# T9 — /);
  assert.ok(report.includes("- Verdict: RED —"));
});

test("claim green path when gate passes and artifact exists at the claimed commit", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "factory") });

  factory.setContract({ task: "T10", workspace, gate: "true", artifact });
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
  const factory = createFactory({ stateDir: join(dir, "factory"), timeoutMs: 250 });

  factory.setContract({ task: "T11", workspace, gate: "sleep 30", artifact });
  const outcome = await factory.claim({ task: "T11", sha });

  assert.equal(outcome.verdict, "red");
  assert.equal(outcome.gate.exit, null);
  assert.match(outcome.gate.note, /timeout/i);
});

test("a gate command that does not exist is red with the shell's exit code", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "factory") });

  factory.setContract({ task: "T12", workspace, gate: "definitely-not-a-command-xyz", artifact });
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

test("a workspace git cannot read is refused at contract time — the base is the diff range (ticket 03 R2)", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "plain");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "format.ts"), "export function pad() {}\n");
  const factory = createFactory({ stateDir: join(dir, "factory") });

  // Since v0.0.2 every Contract records its base commit, so a workspace with
  // no resolvable HEAD is refused up front — scoped or not.
  assert.throws(
    () => factory.setContract({ task: "G1", workspace, gate: "true", artifact: "src/format.ts" }),
    factoryErrorCode("invalid-contract"),
  );
  assert.deepEqual([...factory.ledger.events], []);
});

test("scoped contract: an in-scope-only diff behaves exactly as today", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspace(dir);
  const stateDir = join(dir, "factory");
  const factory = createFactory({ stateDir });

  factory.setContract({ task: "SC1", workspace, gate: "true", artifact, scope: ["src"] });
  writeFileSync(join(workspace, "src", "extra.ts"), "export const extra = 1;\n");
  const sha2 = gitCommitChanges(workspace, "add extra module in scope");
  const outcome = await factory.claim({ task: "SC1", sha: sha2 });

  assert.equal(outcome.verdict, "green");
  assert.equal(outcome.gate.sha, sha2);
  const report = readFileSync(outcome.reportPath, "utf8");
  assert.ok(report.includes("scope: `src`"), "the report shows the declared boundary");
});

test("scoped contract: one file outside scope is red with that file named", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "factory") });

  factory.setContract({ task: "SC2", workspace, gate: "true", artifact, scope: ["src"] });
  writeFileSync(join(workspace, "src", "extra.ts"), "export const extra = 1;\n");
  writeFileSync(join(workspace, "README.md"), "# touched out of scope\n");
  const sha2 = gitCommitChanges(workspace, "add extra module and touch README");
  const outcome = await factory.claim({ task: "SC2", sha: sha2 });

  assert.equal(outcome.verdict, "red");
  assert.equal(outcome.gate.exit, 0, "the gate passed — the overreach is what is red");
  assert.ok(outcome.gate.note.includes("changes outside declared scope"), outcome.gate.note);
  assert.ok(outcome.gate.note.includes("README.md"), "the offending file is named");
  assert.ok(!outcome.gate.note.includes("extra.ts"), "in-scope files are not named");
});

test("omitted scope keeps the unrestricted v0.0.1 behavior", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "factory") });

  factory.setContract({ task: "SC3", workspace, gate: "true", artifact });
  writeFileSync(join(workspace, "README.md"), "# anywhere is fine without a scope\n");
  const sha2 = gitCommitChanges(workspace, "touch README with no scope declared");
  const outcome = await factory.claim({ task: "SC3", sha: sha2 });

  assert.equal(outcome.verdict, "green");
});

test("unusable scope entries are rejected without touching the ledger", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "factory") });

  for (const bad of [["/absolute/path"], ["../escape"], [""], ["ok", ".."]]) {
    assert.throws(
      () => factory.setContract({ task: "SC4", workspace, gate: "true", artifact, scope: bad as string[] }),
      factoryErrorCode("invalid-contract"),
      `scope ${JSON.stringify(bad)} must be rejected`,
    );
  }
  assert.deepEqual([...factory.ledger.events], []);
});

test("a scoped contract refuses a workspace git cannot read", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "plain");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "format.ts"), "export function pad() {}\n");
  const factory = createFactory({ stateDir: join(dir, "factory") });

  assert.throws(
    () => factory.setContract({ task: "SC5", workspace, gate: "true", artifact: "src/format.ts", scope: ["src"] }),
    factoryErrorCode("invalid-contract"),
  );
});

test("two tasks share one ledger with independent seq and reports", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const stateDir = join(dir, "factory");
  const factory = createFactory({ stateDir });

  factory.setContract({ task: "A1", workspace, gate: "true", artifact });
  factory.setContract({ task: "A2", workspace, gate: "exit 1", artifact });
  const first = await factory.claim({ task: "A1", sha });
  const second = await factory.claim({ task: "A2", sha });

  assert.equal(first.verdict, "green");
  assert.equal(second.verdict, "red");
  assert.deepEqual(factory.ledger.events.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.notEqual(first.reportPath, second.reportPath);
});

test("a second claim after a red attempt opens attempt 2 with its own report (ADR 0003)", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const stateDir = join(dir, "factory");
  const factory = createFactory({ stateDir });

  factory.setContract({ task: "R1", workspace, gate: "exit 1", artifact });
  const first = await factory.claim({ task: "R1", sha });
  const second = await factory.claim({ task: "R1", sha });

  assert.equal(first.attempt, 1);
  assert.equal(second.attempt, 2);
  assert.equal(second.reportPath, join(stateDir, "report-R1-2.md"));
  assert.ok(existsSync(join(stateDir, "report-R1-1.md")), "attempt 1's report is never overwritten");
  assert.deepEqual(
    factory.ledger.eventsFor("R1").filter((e) => "attempt" in e && e.attempt === 2).map((e) => e.event),
    ["claim_reported", "gate_started", "gate_finished", "report_written"],
  );
  const report2 = readFileSync(second.reportPath, "utf8");
  assert.ok(report2.includes("- Attempt: 2 of 2"));
});

test("a claim while the previous attempt's gate is still running is rejected (ADR 0003)", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "factory") });

  factory.setContract({ task: "R2", workspace, gate: "sleep 1", artifact });
  const inFlight = factory.claim({ task: "R2", sha });
  await assert.rejects(factory.claim({ task: "R2", sha }), factoryErrorCode("gate-running"));
  const outcome = await inFlight;
  assert.equal(outcome.attempt, 1, "the original claim completes untouched");
  assert.deepEqual(
    factory.ledger.eventsFor("R2").map((e) => e.event),
    ["contract_set", "claim_reported", "gate_started", "gate_finished", "report_written"],
    "the rejected claim appended nothing",
  );
});

test("accept: the Owner accepts a green attempt, once, and only green attempts (ADR 0002)", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const stateDir = join(dir, "factory");
  const factory = createFactory({ stateDir });

  factory.setContract({ task: "AC1", workspace, gate: "grep -q padEnd src/format.ts", artifact });
  const red = await factory.claim({ task: "AC1", sha });
  assert.equal(red.verdict, "red");
  assert.throws(() => factory.accept({ task: "AC1", attempt: 1 }), factoryErrorCode("not-green"));
  assert.deepEqual(
    factory.ledger.eventsFor("AC1").filter((e) => e.event === "attempt_accepted"),
    [],
    "a rejected acceptance writes nothing",
  );

  // The agent fixes the work; the next attempt is green and acceptable.
  writeFileSync(join(workspace, artifact), "export function pad(input: string, width: number): string {\n  return input.padEnd(width).slice(0, width);\n}\n");
  const sha2 = gitCommitChanges(workspace, "fix pad");
  const green = await factory.claim({ task: "AC1", sha: sha2 });
  assert.equal(green.verdict, "green");

  const accepted = factory.accept({ task: "AC1", attempt: green.attempt });
  assert.equal(accepted.event, "attempt_accepted");
  assert.equal(accepted.attempt, green.attempt);

  assert.throws(() => factory.accept({ task: "AC1", attempt: 1 }), factoryErrorCode("already-accepted"));
  assert.throws(() => factory.accept({ task: "AC1", attempt: 9 }), factoryErrorCode("unknown-attempt"));
  assert.throws(() => factory.accept({ task: "AC2", attempt: 1 }), factoryErrorCode("unknown-task"));
  assert.throws(() => factory.accept({ task: "AC1", attempt: 0 }), factoryErrorCode("invalid-attempt"));
});

test("opening the ledger closes an attempt interrupted mid-gate: red, reported, logged (ADR 0003)", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const stateDir = join(dir, "factory");

  // The factory "crashes" mid-gate: claim_reported + gate_started, nothing after.
  const crashed = createFactory({ stateDir });
  crashed.setContract({ task: "REC1", workspace, gate: "sleep 30", artifact });
  crashed.ledger.append({ event: "claim_reported", task: "REC1", attempt: 1, sha });
  crashed.ledger.append({ event: "gate_started", task: "REC1", attempt: 1, cmd: "sleep 30" });

  const reopened = createFactory({ stateDir });

  assert.deepEqual(reopened.recoveredAttempts, [{ task: "REC1", attempt: 1 }]);
  const gate = reopened.ledger.eventsFor("REC1").findLast((e) => e.event === "gate_finished");
  assert.equal(gate?.verdict, "red");
  assert.equal(gate?.exit, null);
  assert.match(gate?.note ?? "", /interrupted — the factory restarted before the Gate finished/);
  const reportPath = join(stateDir, "report-REC1-1.md");
  assert.ok(existsSync(reportPath), "the recovered attempt still gets its report");
  assert.match(readFileSync(reportPath, "utf8"), /- Verdict: RED — interrupted/);

  // The task is claimable again — the recovered attempt is closed.
  const next = await reopened.claim({ task: "REC1", sha });
  assert.equal(next.attempt, 2, "the next claim opens attempt 2, never reuses the interrupted one");
});

test("opening the ledger closes an attempt interrupted before the gate even started", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, sha } = makeWorkspace(dir);
  const stateDir = join(dir, "factory");

  const crashed = createFactory({ stateDir });
  crashed.setContract({ task: "REC2", workspace, gate: "true", artifact });
  crashed.ledger.append({ event: "claim_reported", task: "REC2", attempt: 1, sha });

  const reopened = createFactory({ stateDir });

  assert.deepEqual(reopened.recoveredAttempts, [{ task: "REC2", attempt: 1 }]);
  const gate = reopened.ledger.eventsFor("REC2").findLast((e) => e.event === "gate_finished");
  assert.match(gate?.note ?? "", /interrupted — the factory restarted before the Gate started/);
});
