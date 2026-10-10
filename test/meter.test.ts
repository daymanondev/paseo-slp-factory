import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../plugin/server/core/factory.ts";
import { handleSpoolRequest, parseSpoolRequest } from "../plugin/server/spool.ts";
import { usageOf } from "../plugin/bin/driver.mjs";
import { Ledger, usageIsValid } from "../src/ledger.ts";
import { disposeDir, gitCommitAll, makeTempDir } from "./helpers.ts";
import type { Factory, MeterInput } from "../plugin/server/core/factory.ts";
import type { MeterWritten } from "../plugin/server/core/events.ts";

/**
 * The Meter (v0.0.8, ticket 03 items 1–2) — hermetic throughout, no live
 * model call anywhere: the factory's `meter` station (validation, the one
 * line, usage verbatim in the daemon's camelCase, fields present only when
 * the lane provided them), the spool's `meter` request kind (strict shape,
 * a refused meter writes no line), the ledger's open-time validation of the
 * new event, and the driver's usage extraction off a snapshot.
 */

const CLAUDE_USAGE = { inputTokens: 84_000, cachedInputTokens: 688_000, outputTokens: 10_000, totalCostUsd: 1.02 };

function meterEvent(factory: Factory, task: string): MeterWritten {
  const meter = factory.ledger.eventsFor(task).findLast((e): e is MeterWritten => e.event === "meter_written");
  assert.ok(meter, "meter_written landed");
  return meter;
}

/** A git workspace with the task contracted, ready to meter. */
function setup(dir: string, task: string): Factory {
  const workspace = join(dir, `ws-${task}`);
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "x.ts"), "export const x = 1;\n");
  gitCommitAll(workspace);
  const factory = createFactory({ stateDir: join(dir, "state") });
  factory.setContract({ task, workspace, gate: "true", artifact: "x.ts" });
  return factory;
}

test("meter appends one task-scoped line: usage verbatim camelCase, provider verbatim, optional agent", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const factory = setup(dir, "M1");
  const before = factory.ledger.events.length;

  const written = factory.meter({ task: "M1", provider: "claude/claude-sonnet-5", usage: { ...CLAUDE_USAGE }, agent: "agent-m1" });

  assert.equal(written.event, "meter_written");
  assert.equal(factory.ledger.events.length, before + 1, "exactly one line");
  const line = meterEvent(factory, "M1");
  assert.equal(line.task, "M1");
  assert.ok(!("attempt" in line), "no attempt — usage spans the whole run, like the spawn lines");
  assert.deepEqual(line.usage, CLAUDE_USAGE, "the daemon's shape passes through verbatim");
  assert.equal(line.provider, "claude/claude-sonnet-5", "the provider[/model] string verbatim");
  assert.equal(line.agent, "agent-m1", "the metered agent rides when the driver knows it");
  assert.ok(Number.isInteger(line.seq));
});

test("meter with an empty usage records the honest absence — an empty object, never a fabricated zero", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const factory = setup(dir, "M2");

  const written = factory.meter({ task: "M2", provider: "copilot/gpt-5.4", usage: {} });

  assert.deepEqual(written.usage, {});
  assert.ok(!("totalCostUsd" in written.usage), "no dollar key poses as a measured zero");
});

test("meter refusals write no line: unknown task, empty provider, malformed usage, unusable agent", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const factory = setup(dir, "M3");
  const before = factory.ledger.events.length;

  const cases: [unknown, string, RegExp][] = [
    [{ task: "GHOST", provider: "claude", usage: {} }, "unknown-task", /no contract set for task GHOST/],
    [{ task: "M3", provider: "  ", usage: {} }, "invalid-meter", /non-empty string/],
    [{ task: "M3", provider: "claude", usage: { totalCostUsd: "1.02" } }, "invalid-meter", /four fields/],
    [{ task: "M3", provider: "claude", usage: { contextWindowUsedTokens: 5 } }, "invalid-meter", /four fields/],
    [{ task: "M3", provider: "claude", usage: {} , agent: "  " }, "invalid-meter", /non-empty string/],
  ];
  for (const [input, code, message] of cases) {
    // Duck-typed on the code: the vendored core's FactoryError is a different
    // class from src/errors.ts, so instanceof across the copies would lie.
    assert.throws(
      () => factory.meter(input as MeterInput),
      (err: unknown): boolean => err instanceof Error && (err as { code?: unknown }).code === code && message.test(err.message),
      `${code}: ${JSON.stringify(input)}`,
    );
  }
  assert.equal(factory.ledger.events.length, before, "nothing changed, nothing recorded");
});

test("a re-run task lands a second meter line; the read side takes the latest", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const factory = setup(dir, "M4");

  factory.meter({ task: "M4", provider: "claude/claude-sonnet-5", usage: { totalCostUsd: 2.65 } });
  factory.meter({ task: "M4", provider: "claude/claude-sonnet-5", usage: { totalCostUsd: 3.4 } });

  const lines = factory.ledger.eventsFor("M4").filter((e) => e.event === "meter_written");
  assert.equal(lines.length, 2, "one line per task per driver run");
  assert.equal(meterEvent(factory, "M4").usage.totalCostUsd, 3.4, "findLast reads the re-run's line");
});

test("the ledger refuses to open a meter line with junk usage — the shape is the contract", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  const good = { seq: 1, ts: "2026-10-10T09:00:00.000Z", event: "contract_set", task: "T1", workspace: "/w", gate: "true", artifact: "a" };
  const meter = { seq: 2, ts: "2026-10-10T09:01:00.000Z", event: "meter_written", task: "T1", provider: "claude", usage: { pennies: "many" } };
  writeFileSync(join(stateDir, "ledger.jsonl"), `${JSON.stringify(good)}\n${JSON.stringify(meter)}\n`);
  assert.throws(() => Ledger.open(join(stateDir, "ledger.jsonl")), /is not a valid ledger event/);
});

test("parseSpoolRequest accepts exactly the meter shape and nothing around it", () => {
  assert.deepEqual(parseSpoolRequest({ id: "r1", kind: "meter", task: "T1", provider: "claude/claude-sonnet-5", usage: { totalCostUsd: 2.65 } }), {
    id: "r1",
    kind: "meter",
    task: "T1",
    provider: "claude/claude-sonnet-5",
    usage: { totalCostUsd: 2.65 },
  });
  assert.deepEqual(
    parseSpoolRequest({ id: "r1", kind: "meter", task: "T1", provider: "copilot/gpt-5.4", usage: {}, agent: "ag-1" }),
    { id: "r1", kind: "meter", task: "T1", provider: "copilot/gpt-5.4", usage: {}, agent: "ag-1" },
    "an empty usage and an agent ride",
  );
  for (const bad of [
    { id: "r1", kind: "meter", task: "T1", provider: "claude" },
    { id: "r1", kind: "meter", task: "T1", provider: "claude", usage: [] },
    { id: "r1", kind: "meter", task: "T1", provider: "claude", usage: { inputTokens: "84" } },
    { id: "r1", kind: "meter", task: "T1", provider: "claude", usage: { noise: 1 } },
    { id: "r1", kind: "meter", task: "T1", provider: "  ", usage: {} },
    { id: "r1", kind: "meter", task: "T1", provider: "claude", usage: {}, agent: 7 },
    { kind: "meter", task: "T1", provider: "claude", usage: {} },
  ]) {
    assert.equal(parseSpoolRequest(bad), undefined, `${JSON.stringify(bad)} must be rejected`);
  }
});

test("handleSpoolRequest meters through the spool: one line, dollars in the summary, refusals write nothing", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const factory = setup(dir, "M5");
  const before = factory.ledger.events.length;

  const written = await handleSpoolRequest(factory, { id: "r1", kind: "meter", task: "M5", provider: "claude/claude-sonnet-5", usage: { ...CLAUDE_USAGE }, agent: "ag-1" });
  assert.equal(written.ok, true);
  if (written.ok) assert.match(written.summary, /meter for M5 under claude\/claude-sonnet-5: \$1\.02/);
  assert.equal(factory.ledger.events.length, before + 1, "the line landed");

  const absent = await handleSpoolRequest(factory, { id: "r2", kind: "meter", task: "M5", provider: "copilot/gpt-5.4", usage: {} });
  assert.equal(absent.ok, true);
  if (absent.ok) assert.match(absent.summary, /no dollars reported/, "the absence is named, not zeroed");

  const refused = await handleSpoolRequest(factory, { id: "r3", kind: "meter", task: "GHOST", provider: "claude", usage: {} });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.code, "unknown-task");
  assert.equal(factory.ledger.events.length, before + 2, "the refusal wrote no line — the two written meters stand");
});

test("usageIsValid accepts the four daemon fields and nothing else", () => {
  assert.equal(usageIsValid({}), true, "the empty object is the honest empty capture");
  assert.equal(usageIsValid({ ...CLAUDE_USAGE }), true);
  assert.equal(usageIsValid({ totalCostUsd: 2.65 }), true, "fields may ride alone");
  for (const bad of [
    undefined,
    null,
    "usage",
    [],
    { inputTokens: "84000" },
    { totalCostUsd: Number.NaN },
    { totalCostUsd: Number.POSITIVE_INFINITY },
    { contextWindowUsedTokens: 5 }, // a daemon gauge that is not a meter field
  ]) {
    assert.equal(usageIsValid(bad), false, `${JSON.stringify(bad)} must be rejected`);
  }
});

test("usageOf reduces a snapshot's lastUsage to the four fields, present only when finite", () => {
  assert.deepEqual(usageOf(undefined), {}, "no lastUsage at all — the honest empty capture");
  assert.deepEqual(usageOf(null), {});
  assert.deepEqual(usageOf({ status: "idle" }), {}, "a snapshot-shaped object with no usage keys");
  assert.deepEqual(
    usageOf({ ...CLAUDE_USAGE }),
    { ...CLAUDE_USAGE },
    "the daemon's camelCase passes through verbatim",
  );
  assert.deepEqual(usageOf({ inputTokens: 5, totalCostUsd: null }), { inputTokens: 5 }, "a null cost is an absent cost, never zero");
  assert.deepEqual(
    usageOf({ inputTokens: 5, contextWindowMaxTokens: 200_000, contextWindowUsedTokens: 5 }),
    { inputTokens: 5 },
    "the context-window gauges stay off the meter",
  );
});
