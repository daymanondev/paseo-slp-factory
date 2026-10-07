import { test } from "node:test";
import assert from "node:assert/strict";
import { renderReport } from "../src/report.ts";
import type { LedgerEvent } from "../src/events.ts";
import { factoryErrorCode } from "./helpers.ts";

function docSection2Events(): LedgerEvent[] {
  return [
    { seq: 1, ts: "2026-10-01T14:04:00.000Z", event: "contract_set", task: "T1", workspace: "/workspaces/sample", gate: "npm test", artifact: "src/format.ts" },
    { seq: 2, ts: "2026-10-01T14:05:00.000Z", event: "claim_reported", task: "T1", attempt: 1, sha: "a1b2c3d" },
    { seq: 3, ts: "2026-10-01T14:05:01.000Z", event: "gate_started", task: "T1", attempt: 1, cmd: "npm test" },
    { seq: 4, ts: "2026-10-01T14:05:30.000Z", event: "gate_finished", task: "T1", attempt: 1, exit: 1, verdict: "red", note: "2 tests failed" },
    { seq: 5, ts: "2026-10-01T14:05:31.000Z", event: "report_written", task: "T1", attempt: 1, path: "factory/report-T1-1.md" },
  ];
}

test("renders the report shape for a red gate — evidence only, timestamps from events (ADR 0003)", () => {
  const report = renderReport("T1", 1, docSection2Events());
  assert.equal(
    report,
    [
      "# T1 — 2026-10-01 14:05 UTC",
      "- Attempt: 1 of 1",
      "- Contract: `npm test` green · file `src/format.ts` exists",
      "- Workspace: /workspaces/sample",
      "- Claimed @ 2026-10-01 14:05 UTC: a1b2c3d",
      "- Verdict: RED — 2 tests failed",
      "- Contract not met — send the gate note back to the agent, with the reminder: do not make the tests green yourself.",
      "",
    ].join("\n"),
  );
});

test("renders evidence-not-acceptance for a green gate, with the attested commit", () => {
  const events: LedgerEvent[] = [
    { seq: 1, ts: "2026-10-01T08:59:00.000Z", event: "contract_set", task: "T2", workspace: "/workspaces/sample", gate: "npm test", artifact: "src/format.ts" },
    { seq: 2, ts: "2026-10-01T09:00:00.000Z", event: "claim_reported", task: "T2", attempt: 1, sha: "feed123" },
    { seq: 3, ts: "2026-10-01T09:00:01.000Z", event: "gate_started", task: "T2", attempt: 1, cmd: "npm test" },
    { seq: 4, ts: "2026-10-01T09:00:20.000Z", event: "gate_finished", task: "T2", attempt: 1, exit: 0, verdict: "green", note: "3 pass 0 fail", sha: "feed1234567890abcdef4567890abcdef4567890" },
    { seq: 5, ts: "2026-10-01T09:00:21.000Z", event: "report_written", task: "T2", attempt: 1, path: "factory/report-T2-1.md" },
  ];
  const report = renderReport("T2", 1, events);
  assert.ok(report.startsWith("# T2 — 2026-10-01 09:00 UTC"), "header time is the verdict time, not render time");
  assert.ok(report.includes("- Verdict: GREEN — 3 pass 0 fail"));
  assert.ok(report.includes("- Attested commit: `feed1234567890abcdef4567890abcdef4567890`"));
  assert.ok(report.includes("- Evidence, not acceptance"));
  assert.ok(!report.includes("Conclusion"));
});

test("renders one attempt out of many, ignoring other tasks and attempts", () => {
  const events: LedgerEvent[] = [
    { seq: 1, ts: "2026-10-01T09:00:00.000Z", event: "contract_set", task: "T9", workspace: "/w", gate: "old gate", artifact: "old.ts" },
    { seq: 2, ts: "2026-10-01T09:00:00.000Z", event: "contract_set", task: "T3", workspace: "/w", gate: "first gate", artifact: "a.ts" },
    { seq: 3, ts: "2026-10-01T09:01:00.000Z", event: "claim_reported", task: "T3", attempt: 1, sha: "aaa" },
    { seq: 4, ts: "2026-10-01T09:01:01.000Z", event: "gate_started", task: "T3", attempt: 1, cmd: "first gate" },
    { seq: 5, ts: "2026-10-01T09:01:30.000Z", event: "gate_finished", task: "T3", attempt: 1, exit: 1, verdict: "red", note: "first run red" },
    { seq: 6, ts: "2026-10-01T09:03:00.000Z", event: "report_written", task: "T3", attempt: 1, path: "factory/report-T3-1.md" },
    { seq: 7, ts: "2026-10-01T09:05:00.000Z", event: "claim_reported", task: "T3", attempt: 2, sha: "bbb" },
    { seq: 8, ts: "2026-10-01T09:05:01.000Z", event: "gate_started", task: "T3", attempt: 2, cmd: "first gate" },
    { seq: 9, ts: "2026-10-01T09:05:30.000Z", event: "gate_finished", task: "T3", attempt: 2, exit: 0, verdict: "green", note: "second run green" },
  ];
  const report = renderReport("T3", 2, events);
  assert.ok(report.includes("- Attempt: 2 of 2"));
  assert.ok(report.includes("- Contract: `first gate` green · file `a.ts` exists"));
  assert.ok(report.includes("- Claimed @ 2026-10-01 09:05 UTC: bbb"));
  assert.ok(report.includes("- Verdict: GREEN — second run green"));

  const first = renderReport("T3", 1, events);
  assert.ok(first.includes("- Attempt: 1 of 2"), "attempt count covers the whole task");
  assert.ok(first.includes("- Verdict: RED — first run red"), "attempt 1 renders its own verdict");
});

test("refuses to render when the attempt history is incomplete", () => {
  const events = docSection2Events().filter((e) => e.event !== "gate_finished");
  assert.throws(
    () => renderReport("T1", 1, events),
    factoryErrorCode("incomplete-history"),
  );
});
