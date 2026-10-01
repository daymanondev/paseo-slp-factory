import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../src/index.ts";
import { copyFixture, disposeDir, makeTempDir } from "./helpers.ts";

/**
 * The scripted integration scenario from ticket 07 / roadmap §2:
 * contract set → done reported → gate runs red (`npm test`, 2 failing tests)
 * → report says not-done. The ledger must reproduce the doc's five lines
 * essentially line for line.
 */
test("roadmap §2 scenario: red npm test produces the doc's ledger and a not-done report", async (t) => {
  const tmp = makeTempDir();
  disposeDir(t, tmp);
  const workspace = join(tmp, "workspace");
  copyFixture("sample-workspace", workspace);
  const stateDir = join(tmp, "factory");

  const factory = createFactory({ stateDir, workspace });
  factory.setContract({ task: "T1", gate: "npm test", artifact: "src/format.ts" });
  const outcome = await factory.reportDone({ task: "T1", sha: "a1b2c3d" });

  assert.equal(outcome.verdict, "red");
  assert.equal(outcome.gate.exit, 1);

  const lines = readFileSync(join(stateDir, "ledger.jsonl"), "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 5, "exactly the five roadmap events");
  // The doc's literal first three lines — same event, fields, and order.
  assert.equal(lines[0], '{"seq":1,"event":"contract_set","task":"T1","gate":"npm test","artifact":"src/format.ts"}');
  assert.equal(lines[1], '{"seq":2,"event":"done_reported","task":"T1","sha":"a1b2c3d"}');
  assert.equal(lines[2], '{"seq":3,"event":"gate_started","task":"T1","cmd":"npm test"}');

  const gate = JSON.parse(lines[3]!) as { seq: number; event: string; task: string; exit: number; verdict: string; note: string };
  assert.deepEqual(
    { seq: gate.seq, event: gate.event, task: gate.task, exit: gate.exit, verdict: gate.verdict },
    { seq: 4, event: "gate_finished", task: "T1", exit: 1, verdict: "red" },
  );
  assert.match(gate.note, /fail 2/, "the note carries the real test failure summary");

  const reportWritten = JSON.parse(lines[4]!) as { seq: number; event: string; task: string; path: string };
  assert.deepEqual(reportWritten, {
    seq: 5,
    event: "report_written",
    task: "T1",
    path: join(stateDir, "report-T1.md"),
  });

  const report = readFileSync(join(stateDir, "report-T1.md"), "utf8");
  assert.match(report, /^# T1 — \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/m);
  assert.ok(report.includes("- Contract: `npm test` green · file `src/format.ts` exists"));
  assert.ok(report.includes("- Agent reported done @ a1b2c3d"));
  assert.ok(report.includes("- Gate: RED — "));
  assert.ok(report.includes("- Conclusion: NOT done —"));
});

test("the same workspace passes once the artifact actually satisfies its tests", async (t) => {
  const tmp = makeTempDir();
  disposeDir(t, tmp);
  const workspace = join(tmp, "workspace");
  copyFixture("sample-workspace", workspace);
  const stateDir = join(tmp, "factory");

  const factory = createFactory({ stateDir, workspace });
  factory.setContract({ task: "T2", gate: "npm test", artifact: "src/format.ts" });

  // The agent fixes the work for real, then claims done again.
  writeFileSync(
    join(workspace, "src", "format.ts"),
    [
      "export function pad(input: string, width: number): string {",
      "  if (input.length >= width) return input.slice(0, width);",
      "  return input + \" \".repeat(width - input.length);",
      "}",
      "",
    ].join("\n"),
  );

  const outcome = await factory.reportDone({ task: "T2", sha: "f00dcafe" });
  assert.equal(outcome.verdict, "green");
  const report = readFileSync(outcome.reportPath, "utf8");
  assert.ok(report.includes("- Gate: GREEN —"));
  assert.ok(report.includes("- Conclusion: DONE"));
});
