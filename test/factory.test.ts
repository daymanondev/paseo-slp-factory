import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../src/factory.ts";
import { FactoryError } from "../src/errors.ts";
import { disposeDir, makeTempDir } from "./helpers.ts";

function makeWorkspace(dir: string): { workspace: string; artifact: string } {
  const workspace = join(dir, "ws");
  mkdirSync(join(workspace, "src"), { recursive: true });
  const artifact = "src/format.ts";
  writeFileSync(join(workspace, artifact), "export function pad() {}\n");
  return { workspace, artifact };
}

test("setContract records the contract and enforces one contract per task", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const factory = createFactory({ stateDir: join(dir, "factory") });

  const evt = factory.setContract({ task: "T1", gate: "npm test", artifact: "src/format.ts" });

  assert.deepEqual(evt, { seq: 1, event: "contract_set", task: "T1", gate: "npm test", artifact: "src/format.ts" });
  assert.throws(
    () => factory.setContract({ task: "T1", gate: "echo easier", artifact: "x.ts" }),
    (err: unknown) => err instanceof FactoryError && err.code === "contract-exists",
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

test("reportDone without a contract fails before anything is appended", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const factory = createFactory({ stateDir: join(dir, "factory") });

  await assert.rejects(
    factory.reportDone({ task: "T404", sha: "a1b2c3d" }),
    (err: unknown) => err instanceof FactoryError && err.code === "unknown-task",
  );
  await assert.rejects(factory.reportDone({ task: "T404", sha: "" }), FactoryError);
  assert.deepEqual([...factory.ledger.events], []);
});

test("reportDone red path appends the full event sequence and writes the report", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspace(dir);
  const stateDir = join(dir, "factory");
  const factory = createFactory({ stateDir, workspace });

  factory.setContract({ task: "T9", gate: "exit 3", artifact });
  const outcome = await factory.reportDone({ task: "T9", sha: "deadbee" });

  assert.equal(outcome.verdict, "red");
  assert.equal(outcome.gate.exit, 3);
  assert.deepEqual(
    factory.ledger.eventsFor("T9").map((e) => e.event),
    ["contract_set", "done_reported", "gate_started", "gate_finished", "report_written"],
  );
  const report = readFileSync(outcome.reportPath, "utf8");
  assert.match(report, /# T9 — /);
  assert.ok(report.includes("- Gate: RED —"));
  assert.ok(report.includes("- Conclusion: NOT done"));
});

test("reportDone green path when gate passes and artifact exists", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "factory"), workspace });

  factory.setContract({ task: "T10", gate: "true", artifact });
  const outcome = await factory.reportDone({ task: "T10", sha: "c0ffee" });

  assert.equal(outcome.verdict, "green");
  const report = readFileSync(outcome.reportPath, "utf8");
  assert.ok(report.includes("- Conclusion: DONE"));
});

test("reportDone timeout flows through as red with exit null", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspace(dir);
  const factory = createFactory({ stateDir: join(dir, "factory"), workspace, timeoutMs: 250 });

  factory.setContract({ task: "T11", gate: "sleep 30", artifact });
  const outcome = await factory.reportDone({ task: "T11", sha: "beef" });

  assert.equal(outcome.verdict, "red");
  assert.equal(outcome.gate.exit, null);
  assert.match(outcome.gate.note, /timeout/i);
});

test("two tasks share one ledger with independent seq and reports", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspace(dir);
  const stateDir = join(dir, "factory");
  const factory = createFactory({ stateDir, workspace });

  factory.setContract({ task: "A1", gate: "true", artifact });
  factory.setContract({ task: "A2", gate: "exit 1", artifact });
  const first = await factory.reportDone({ task: "A1", sha: "aaaa" });
  const second = await factory.reportDone({ task: "A2", sha: "bbbb" });

  assert.equal(first.verdict, "green");
  assert.equal(second.verdict, "red");
  assert.deepEqual(factory.ledger.events.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.notEqual(first.reportPath, second.reportPath);
});
