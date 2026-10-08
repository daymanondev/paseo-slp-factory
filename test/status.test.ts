import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../plugin/server/core/factory.ts";
import { startSpool } from "../plugin/server/spool.ts";
import { EVENT_NAMES } from "../src/events.ts";
import { copyFixture, disposeDir, gitCommitAll, makeTempDir, repoRoot } from "./helpers.ts";

/**
 * `factory status` — the Owner's read-only glance at the ledger. Unlike
 * contract/accept it never goes through the spool: it reads
 * `<home>/plugin-state/paseo-factory/ledger.jsonl` directly, so these tests
 * exercise it against a real ledger the spool loop wrote, and against
 * hand-written ledgers for the shapes the loop does not produce on demand.
 */

const ownerCli = join(repoRoot, "plugin", "bin", "factory.mjs");
const claimCli = join(repoRoot, "plugin", "bin", "factory-claim.mjs");

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Async on purpose: a sync spawn would block this process's event loop, and the spool poll lives here. */
function run(script: string, args: string[], extraEnv: Record<string, string>): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...extraEnv } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const killer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.on("close", (status) => {
      clearTimeout(killer);
      resolve({ status, stdout, stderr });
    });
  });
}

const ts = "2026-10-07T09:00:00.000Z";

function contractEvent(seq: number, task: string): Record<string, unknown> {
  return { seq, ts, event: "contract_set", task, workspace: "/tmp/ws", gate: "true", artifact: "src/format.ts" };
}

function writeLedger(stateDir: string, events: Record<string, unknown>[]): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "ledger.jsonl"), `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
}

test("the status reader's event vocabulary is in sync with src/events.ts", () => {
  const cli = readFileSync(join(repoRoot, "plugin", "bin", "factory.mjs"), "utf8");
  const match = cli.match(/^const EVENT_NAMES = \[(.*)\];$/m);
  assert.ok(match, "factory.mjs keeps EVENT_NAMES on one line for this drift guard");
  assert.deepEqual(JSON.parse(`[${match![1]}]`), [...EVENT_NAMES]);
});

test("status tracks a whole loop: contract → red claim → green claim → accept", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "workspace");
  copyFixture("sample-workspace", workspace);
  const baseSha = gitCommitAll(workspace); // the fixture's own commit — the tree is clean at it
  const home = join(dir, "paseo-home");
  const stateDir = join(home, "plugin-state", "paseo-factory");

  const factory = createFactory({ stateDir });
  const spool = startSpool(stateDir, factory);
  t.after(() => spool.stop());

  const ownerEnv = { PASEO_HOME: home };
  const agentEnv = { FACTORY_STATE_DIR: stateDir };

  // Before anything has happened there are no task lines — and no error.
  const fresh = await run(ownerCli, ["status"], ownerEnv);
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.match(fresh.stdout, /no tasks yet/);

  const contract = await run(ownerCli, [
    "contract", "--task", "LOOP9", "--workspace", workspace, "--gate", "true", "--artifact", "src/format.ts",
  ], ownerEnv);
  assert.equal(contract.status, 0, contract.stderr);

  // A contract with no attempts yet: counts start at zero, nothing to show.
  const idle = await run(ownerCli, ["status"], ownerEnv);
  assert.equal(idle.status, 0, idle.stderr);
  assert.equal(idle.stdout, "LOOP9 attempts=0 verdict=- sha=- accepted=no eye=-\n");

  // Attempt 1: a claim whose sha resolves to nothing is red before the gate
  // even runs — so this attempt has no attested sha to show.
  const red = await run(claimCli, ["--task", "LOOP9", "--sha", "deadbeef", "--wait-secs", "60"], agentEnv);
  assert.equal(red.status, 1, `expected red\nstdout: ${red.stdout}\nstderr: ${red.stderr}`);
  const afterRed = await run(ownerCli, ["status"], ownerEnv);
  assert.equal(afterRed.status, 0, afterRed.stderr);
  assert.equal(afterRed.stdout, "LOOP9 attempts=1 verdict=red sha=- accepted=no eye=-\n");

  // Attempt 2: the real commit — green, and the verdict attests it (short sha).
  const green = await run(claimCli, ["--task", "LOOP9", "--sha", baseSha, "--wait-secs", "60"], agentEnv);
  assert.equal(green.status, 0, `expected green\nstdout: ${green.stdout}\nstderr: ${green.stderr}`);
  const afterGreen = await run(ownerCli, ["status"], ownerEnv);
  assert.equal(afterGreen.status, 0, afterGreen.stderr);
  assert.equal(afterGreen.stdout, `LOOP9 attempts=2 verdict=green sha=${baseSha.slice(0, 7)} accepted=no eye=-\n`);

  // Acceptance is the Owner's act; status shows its effect on the task.
  const accept = await run(ownerCli, ["accept", "LOOP9", "--attempt", "2"], ownerEnv);
  assert.equal(accept.status, 0, accept.stderr);
  const afterAccept = await run(ownerCli, ["status"], ownerEnv);
  assert.equal(afterAccept.status, 0, afterAccept.stderr);
  assert.equal(afterAccept.stdout, `LOOP9 attempts=2 verdict=green sha=${baseSha.slice(0, 7)} accepted=yes eye=-\n`);
});

test("status prints one line per task in first-appearance order, including mid-gate tasks", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "plugin-state", "paseo-factory");
  const full = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
  writeLedger(stateDir, [
    contractEvent(1, "T-BETA"),
    { seq: 2, ts, event: "contract_set", task: "T-ALPHA", workspace: "/tmp/ws", gate: "true", artifact: "a" },
    contractEvent(3, "T-GAMMA"),
    { seq: 4, ts, event: "claim_reported", task: "T-BETA", attempt: 1, sha: full, agent: "agent-1" },
    { seq: 5, ts, event: "gate_started", task: "T-BETA", attempt: 1, cmd: "true" },
    { seq: 6, ts, event: "gate_finished", task: "T-BETA", attempt: 1, exit: 0, verdict: "green", note: "", sha: full },
    // v0.0.2's advisory line: status reads through it and shows its outcome as
    // the task's eye field (clear here — the last eye on record).
    { seq: 7, ts, event: "fresh_eyes_written", task: "T-BETA", attempt: 1, model: "gemini-3.8-flash-high", outcome: "clear", finding: "nothing to add.", durationMs: 900 },
    { seq: 8, ts, event: "report_written", task: "T-BETA", attempt: 1, path: "/s/report-T-BETA-1.md" },
    { seq: 9, ts, event: "attempt_accepted", task: "T-BETA", attempt: 1 },
    { seq: 10, ts, event: "claim_reported", task: "T-ALPHA", attempt: 1, sha: full },
    { seq: 11, ts, event: "gate_started", task: "T-ALPHA", attempt: 1, cmd: "true" },
    // ...and no gate_finished for T-ALPHA: its attempt is still open.
  ]);

  const status = await run(ownerCli, ["status"], { PASEO_HOME: dir });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(
    status.stdout,
    [
      "T-BETA attempts=1 verdict=green sha=a1b2c3d accepted=yes eye=clear",
      "T-ALPHA attempts=1 verdict=- sha=- accepted=no eye=-",
      "T-GAMMA attempts=0 verdict=- sha=- accepted=no eye=-",
    ].join("\n") + "\n",
  );
});

test("status shows the last fresh-eyes outcome per task, or - when the task has none", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "plugin-state", "paseo-factory");
  const full = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

  function eyeEvent(seq: number, task: string, attempt: number, outcome: string): Record<string, unknown> {
    return { seq, ts, event: "fresh_eyes_written", task, attempt, model: "gemini-3.8-flash-high", outcome, finding: "nothing to add.", durationMs: 900 };
  }

  writeLedger(stateDir, [
    contractEvent(1, "E-CONCERN"),
    { seq: 2, ts, event: "claim_reported", task: "E-CONCERN", attempt: 1, sha: full, agent: "agent-1" },
    { seq: 3, ts, event: "gate_finished", task: "E-CONCERN", attempt: 1, exit: 0, verdict: "green", note: "", sha: full },
    eyeEvent(4, "E-CONCERN", 1, "concern"),
    contractEvent(5, "E-CLEAR"),
    { seq: 6, ts, event: "claim_reported", task: "E-CLEAR", attempt: 1, sha: full, agent: "agent-1" },
    { seq: 7, ts, event: "gate_finished", task: "E-CLEAR", attempt: 1, exit: 0, verdict: "green", note: "", sha: full },
    eyeEvent(8, "E-CLEAR", 1, "concern"),
    { seq: 9, ts, event: "claim_reported", task: "E-CLEAR", attempt: 2, sha: full, agent: "agent-1" },
    { seq: 10, ts, event: "gate_finished", task: "E-CLEAR", attempt: 2, exit: 0, verdict: "green", note: "", sha: full },
    eyeEvent(11, "E-CLEAR", 2, "clear"), // the last eye on record wins, not the first
    contractEvent(12, "E-FAILED"),
    { seq: 13, ts, event: "claim_reported", task: "E-FAILED", attempt: 1, sha: full, agent: "agent-1" },
    { seq: 14, ts, event: "gate_finished", task: "E-FAILED", attempt: 1, exit: 0, verdict: "green", note: "", sha: full },
    eyeEvent(15, "E-FAILED", 1, "failed"),
    contractEvent(16, "E-NONE"),
    { seq: 17, ts, event: "claim_reported", task: "E-NONE", attempt: 1, sha: full, agent: "agent-1" },
    { seq: 18, ts, event: "gate_finished", task: "E-NONE", attempt: 1, exit: 0, verdict: "green", note: "", sha: full },
    // ...and no fresh_eyes_written for E-NONE: the pass never ran on this task.
  ]);

  const status = await run(ownerCli, ["status"], { PASEO_HOME: dir });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(
    status.stdout,
    [
      "E-CONCERN attempts=1 verdict=green sha=a1b2c3d accepted=no eye=concern",
      "E-CLEAR attempts=2 verdict=green sha=a1b2c3d accepted=no eye=clear",
      "E-FAILED attempts=1 verdict=green sha=a1b2c3d accepted=no eye=failed",
      "E-NONE attempts=1 verdict=green sha=a1b2c3d accepted=no eye=-",
    ].join("\n") + "\n",
  );
});

test("status treats a missing or empty ledger as no tasks, not as an error", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "plugin-state", "paseo-factory");

  const missing = await run(ownerCli, ["status"], { PASEO_HOME: dir });
  assert.equal(missing.status, 0, missing.stderr);
  assert.match(missing.stdout, /no tasks yet/);
  assert.match(missing.stdout, /ledger\.jsonl/);

  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "ledger.jsonl"), "");
  const empty = await run(ownerCli, ["status"], { PASEO_HOME: dir });
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /no tasks yet/);
});

test("status refuses a ledger it cannot read, naming the line", async (t) => {
  const good = JSON.stringify(contractEvent(1, "T1"));
  const cases: [string, string, RegExp][] = [
    ["a line that is not JSON", `${good}\nnot json\n`, /line 2 is not valid JSON/],
    ["a blank line inside the file", "\n", /blank line at line 1/],
    ["an unknown event name", `${JSON.stringify({ seq: 1, ts, event: "teleported", task: "T1" })}\n`, /line 1 is not a valid ledger event/],
    ["a line that is not an event object", "[1, 2, 3]\n", /line 1 is not a valid ledger event/],
    ["a claim with no attempt number", `${JSON.stringify({ seq: 1, ts, event: "claim_reported", task: "T1", sha: "a1b2c3d" })}\n`, /line 1 is not a valid ledger event/],
  ];
  for (const [name, content, expected] of cases) {
    const dir = makeTempDir();
    disposeDir(t, dir);
    const stateDir = join(dir, "plugin-state", "paseo-factory");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "ledger.jsonl"), content);
    const result = await run(ownerCli, ["status"], { PASEO_HOME: dir });
    assert.equal(result.status, 2, `${name}: expected exit 2\nstdout: ${result.stdout}`);
    assert.equal(result.stdout, "", `${name}: nothing is printed when the ledger is unreadable`);
    assert.match(result.stderr, expected, name);
    assert.match(result.stderr, /not a readable ledger/, name);
  }
});

test("status refuses bad usage before reading anything", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const extra = await run(ownerCli, ["status", "LOOP9"], { PASEO_HOME: dir });
  assert.equal(extra.status, 2);
  assert.match(extra.stderr, /status: unexpected positional "LOOP9"/);
});

test("an unterminated last ledger line is ignored, not printed (it was never acknowledged)", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "plugin-state", "paseo-factory");
  mkdirSync(stateDir, { recursive: true });
  const good = JSON.stringify(contractEvent(1, "T1"));
  writeFileSync(join(stateDir, "ledger.jsonl"), `${good}\n{"seq":2,"ts":"${ts}",ev`); // crash mid-write

  const result = await run(ownerCli, ["status"], { PASEO_HOME: dir });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "T1 attempts=0 verdict=- sha=- accepted=no eye=-\n");
});

test("a read error that is not a missing file is reported, not swallowed", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  // A home that is a plain file: the ledger path under it cannot exist as a
  // directory entry, so the read fails with something other than ENOENT.
  const notAHome = join(dir, "just-a-file");
  writeFileSync(notAHome, "not a home\n");

  const result = await run(ownerCli, ["status", "--home", notAHome], {});
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /cannot read/);
  assert.doesNotMatch(result.stderr, /no tasks yet/);
});
