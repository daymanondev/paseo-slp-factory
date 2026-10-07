import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../src/index.ts";
import { copyFixture, disposeDir, gitCommitAll, gitCommitChanges, makeTempDir } from "./helpers.ts";

/**
 * The scripted integration scenario from ticket 07 / roadmap §2:
 * contract set → claim reported → gate runs red (`npm test`, 2 failing tests)
 * → report shows the red evidence. The ledger keeps the doc's five-event
 * sequence. §2's literal event name `done_reported` is superseded by ADR 0003
 * (`claim_reported`), and §2's fake sha is superseded by ADR 0002 (the claim
 * must resolve to a real commit), so both are asserted in their ADR shape.
 */
test("roadmap §2 scenario: red npm test produces the five-event ledger and a red-evidence report", async (t) => {
  const tmp = makeTempDir();
  disposeDir(t, tmp);
  const workspace = join(tmp, "workspace");
  copyFixture("sample-workspace", workspace);
  const sha = gitCommitAll(workspace);
  const stateDir = join(tmp, "factory");

  const factory = createFactory({ stateDir, workspace });
  factory.setContract({ task: "T1", gate: "npm test", artifact: "src/format.ts" });
  const outcome = await factory.claim({ task: "T1", sha });

  assert.equal(outcome.verdict, "red");
  assert.equal(outcome.gate.exit, 1);

  const lines = readFileSync(join(stateDir, "ledger.jsonl"), "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 5, "exactly the five roadmap events");
  // The doc's literal first three lines — same events, fields, and order, with
  // the ADR 0002/0003 renames applied.
  assert.equal(lines[0], '{"seq":1,"event":"contract_set","task":"T1","gate":"npm test","artifact":"src/format.ts"}');
  assert.equal(lines[1], `{"seq":2,"event":"claim_reported","task":"T1","sha":"${sha}"}`);
  assert.equal(lines[2], '{"seq":3,"event":"gate_started","task":"T1","cmd":"npm test"}');

  const gate = JSON.parse(lines[3]!) as { seq: number; event: string; task: string; exit: number; verdict: string; note: string; sha?: string };
  assert.deepEqual(
    { seq: gate.seq, event: gate.event, task: gate.task, exit: gate.exit, verdict: gate.verdict, sha: gate.sha },
    { seq: 4, event: "gate_finished", task: "T1", exit: 1, verdict: "red", sha },
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
  assert.ok(report.includes(`- Agent claimed @ ${sha}`));
  assert.ok(report.includes(`- Attested commit: \`${sha}\``));
  assert.ok(report.includes("- Verdict: RED — "));
  assert.ok(!report.includes("Conclusion"), "no acceptance language — ADR 0002");
});

test("the same workspace passes once the agent commits a real fix and claims the new commit", async (t) => {
  const tmp = makeTempDir();
  disposeDir(t, tmp);
  const workspace = join(tmp, "workspace");
  copyFixture("sample-workspace", workspace);
  gitCommitAll(workspace);
  const stateDir = join(tmp, "factory");

  const factory = createFactory({ stateDir, workspace });
  factory.setContract({ task: "T2", gate: "npm test", artifact: "src/format.ts" });

  // The agent fixes the work for real, commits it, then claims the new commit.
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
  const fixedSha = gitCommitChanges(workspace, "fix pad to truncate and pad correctly");

  const outcome = await factory.claim({ task: "T2", sha: fixedSha });
  assert.equal(outcome.verdict, "green");
  const report = readFileSync(outcome.reportPath, "utf8");
  assert.ok(report.includes("- Verdict: GREEN —"));
  assert.ok(report.includes("- Evidence, not acceptance"));
});
