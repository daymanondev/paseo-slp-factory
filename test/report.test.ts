import { test } from "node:test";
import assert from "node:assert/strict";
import { renderReport } from "../src/report.ts";
import type { LedgerEvent } from "../src/events.ts";
import { factoryErrorCode } from "./helpers.ts";

function docSection2Events(): LedgerEvent[] {
  return [
    { seq: 1, event: "contract_set", task: "T1", gate: "npm test", artifact: "src/format.ts" },
    { seq: 2, event: "done_reported", task: "T1", sha: "a1b2c3d" },
    { seq: 3, event: "gate_started", task: "T1", cmd: "npm test" },
    { seq: 4, event: "gate_finished", task: "T1", exit: 1, verdict: "red", note: "2 tests failed" },
    { seq: 5, event: "report_written", task: "T1", path: "factory/report-T1.md" },
  ];
}

test("renders the doc §2 report shape for a red gate", () => {
  const now = new Date("2026-10-01T14:05:00Z");
  const report = renderReport("T1", docSection2Events(), now);
  assert.equal(
    report,
    [
      "# T1 — 2026-10-01 14:05 UTC",
      "- Contract: `npm test` green · file `src/format.ts` exists",
      "- Agent reported done @ a1b2c3d",
      "- Gate: RED — 2 tests failed",
      "- Conclusion: NOT done — send the red gate back to the agent with the reminder: do not make the tests green yourself.",
      "",
    ].join("\n"),
  );
});

test("renders DONE for a green gate", () => {
  const events: LedgerEvent[] = [
    { seq: 1, event: "contract_set", task: "T2", gate: "npm test", artifact: "src/format.ts" },
    { seq: 2, event: "done_reported", task: "T2", sha: "feed123" },
    { seq: 3, event: "gate_started", task: "T2", cmd: "npm test" },
    { seq: 4, event: "gate_finished", task: "T2", exit: 0, verdict: "green", note: "3 pass 0 fail" },
    { seq: 5, event: "report_written", task: "T2", path: "factory/report-T2.md" },
  ];
  const report = renderReport("T2", events, new Date("2026-10-01T09:00:00Z"));
  assert.ok(report.includes("- Gate: GREEN — 3 pass 0 fail"));
  assert.ok(report.includes("- Conclusion: DONE — contract met (gate green, artifact present)."));
});

test("uses the latest event of each kind and ignores other tasks", () => {
  const events: LedgerEvent[] = [
    { seq: 1, event: "contract_set", task: "T9", gate: "old gate", artifact: "old.ts" },
    { seq: 2, event: "contract_set", task: "T3", gate: "first gate", artifact: "a.ts" },
    { seq: 3, event: "done_reported", task: "T3", sha: "aaa" },
    { seq: 4, event: "gate_started", task: "T3", cmd: "first gate" },
    { seq: 5, event: "gate_finished", task: "T3", exit: 1, verdict: "red", note: "first run red" },
    { seq: 6, event: "done_reported", task: "T3", sha: "bbb" },
    { seq: 7, event: "gate_started", task: "T3", cmd: "first gate" },
    { seq: 8, event: "gate_finished", task: "T3", exit: 0, verdict: "green", note: "second run green" },
  ];
  const report = renderReport("T3", events, new Date("2026-10-01T09:00:00Z"));
  assert.ok(report.includes("- Contract: `first gate` green · file `a.ts` exists"));
  assert.ok(report.includes("- Agent reported done @ bbb"));
  assert.ok(report.includes("- Gate: GREEN — second run green"));
});

test("refuses to render when the task history is incomplete", () => {
  const events = docSection2Events().filter((e) => e.event !== "gate_finished");
  assert.throws(
    () => renderReport("T1", events),
    factoryErrorCode("incomplete-history"),
  );
});
