#!/usr/bin/env node
/**
 * factory — the Owner's CLI (ADR 0002 / ADR 0004). Never placed on an agent's
 * PATH: setting the Contract and accepting an Attempt are the Owner's acts.
 *
 *   factory [--home <paseoHome>] contract --task <id> --workspace <dir> \
 *       --gate <command> --artifact <path> [--scope <p1,p2,...>] [--wait-secs <n>]
 *   factory [--home <paseoHome>] accept <task> --attempt <n> [--wait-secs <n>]
 *   factory [--home <paseoHome>] status
 *
 * contract and accept submit through the spool and wait for the plugin's
 * reply — the CLI never writes the ledger. status is a local, read-only view
 * of the ledger: one line per task, no plugin needed (it reads the same file
 * the single writer maintains, never touching it).
 *
 * The home defaults to `PASEO_HOME` or `~/.paseo`; against the trial daemon
 * pass `--home ~/.paseo-factory`.
 *
 * Exit codes: 0 the command succeeded · 2 it did not (bad usage, rejected by
 * the factory, no reply from the plugin, or an unreadable ledger).
 */
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { awaitReply, randomId, resolveHome, spoolRootFor, stateDirFor, submit } from "./spool-client.mjs";

const usage = `usage: factory [--home <paseoHome>] <command> [options]

commands:
  contract   Set a task's done-criteria (the Owner's act — fixed before the
             agent starts; one contract per task id, the ledger is append-only)
             --task <id> --workspace <dir> --gate <command> --artifact <path>
             [--scope <p1,p2,...>]   workspace-relative prefixes the task may touch
             [--fresh-eyes]          mark the fresh-eyes pass ON for this task
                                     (needs <stateDir>/eye.json; the pass is
                                     advisory and runs only on green verdicts)

  accept     Accept one green attempt of a task (the Owner's act)
             accept <task> --attempt <n>

  status     Print one line per task from the ledger — attempts, last verdict,
             attested sha (short), accepted. A local read; the plugin need not
             be running.

options:
  --home <paseoHome>   daemon home (default: $PASEO_HOME or ~/.paseo)
  --wait-secs <n>      how long to wait for the plugin's reply (default: 60)`;

const DEFAULT_WAIT_SECS = 60;

// The event vocabulary the status reader understands — mirrored from
// src/events.ts because the CLIs import no src/ code (ADR 0004). Kept on one
// line so test/status.test.ts can guard this copy against drift. Kept in sync
// with the writer by the same suite, the way test/cli.test.ts guards the spool.
const EVENT_NAMES = ["contract_set", "claim_reported", "gate_started", "gate_finished", "fresh_eyes_written", "report_written", "attempt_accepted"];

function fail(message) {
  console.error(`factory: ${message}\n\n${usage}`);
  process.exit(2);
}

// Split the global --home (and its value) out of argv, leaving the subcommand
// and its own options behind.
const argv = process.argv.slice(2);
let homeFlag;
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--home") {
    if (i + 1 >= argv.length) fail("--home needs a value");
    homeFlag = argv[++i];
  } else if (typeof arg === "string" && arg.startsWith("--home=")) {
    homeFlag = arg.slice("--home=".length);
  } else {
    rest.push(arg);
  }
}

const command = rest.shift();
if (command === "--help" || command === "help" || command === undefined) {
  console.log(usage);
  process.exit(command === undefined ? 2 : 0);
}

const stateDir = stateDirFor(resolveHome(homeFlag));
const spoolRoot = spoolRootFor(stateDir);

function parseCommandOptions(spec) {
  try {
    return parseArgs({ strict: true, args: rest, options: spec, allowPositionals: true });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

function waitSeconds(parsed) {
  const raw = parsed.values["wait-secs"];
  if (raw === undefined) return DEFAULT_WAIT_SECS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) fail("--wait-secs must be a positive number");
  return n;
}

async function roundTrip(request, waitSecs) {
  submit(spoolRoot, request);
  const reply = await awaitReply(spoolRoot, request.id, waitSecs * 1000);
  if (reply === null) {
    console.error(
      `factory: no reply from the factory plugin after ${waitSecs}s — is the plugin running on this home? ` +
        `The request (${request.id}) stays in the spool and may still be processed.`,
    );
    process.exit(2);
  }
  if (!reply.ok) {
    console.error(`factory: ${reply.message}`);
    process.exit(2);
  }
  return reply;
}

if (command === "contract") {
  const parsed = parseCommandOptions({
    task: { type: "string" },
    workspace: { type: "string" },
    gate: { type: "string" },
    artifact: { type: "string" },
    scope: { type: "string" },
    "fresh-eyes": { type: "boolean", default: false },
    "wait-secs": { type: "string" },
  });
  const v = parsed.values;
  if (typeof v.task !== "string") fail("contract: --task is required");
  if (typeof v.workspace !== "string") fail("contract: --workspace is required");
  if (typeof v.gate !== "string") fail("contract: --gate is required");
  if (typeof v.artifact !== "string") fail("contract: --artifact is required");
  if (parsed.positionals.length > 0) fail(`contract: unexpected positional "${parsed.positionals[0]}"`);

  const request = {
    id: randomId(),
    kind: "contract",
    task: v.task,
    workspace: resolvePath(v.workspace), // fixed, absolute — the agent never picks a cwd
    gate: v.gate,
    artifact: v.artifact,
    ...(v.scope === undefined
      ? {}
      : { scope: v.scope.split(",").map((s) => s.trim()).filter((s) => s !== "") }),
    ...(v["fresh-eyes"] ? { freshEyes: true } : {}),
  };
  const reply = await roundTrip(request, waitSeconds(parsed));
  console.log(`factory: ${reply.summary}`);
  process.exit(0);
}

if (command === "accept") {
  const parsed = parseCommandOptions({
    attempt: { type: "string" },
    "wait-secs": { type: "string" },
  });
  const task = parsed.positionals[0];
  if (task === undefined) fail("accept: a task id is required (factory accept <task> --attempt <n>)");
  if (parsed.positionals.length > 1) fail(`accept: unexpected positional "${parsed.positionals[1]}"`);
  const attempt = Number(parsed.values.attempt);
  if (!Number.isInteger(attempt) || attempt < 1) fail("accept: --attempt must be a positive integer");

  const reply = await roundTrip({ id: randomId(), kind: "accept", task, attempt }, waitSeconds(parsed));
  console.log(`factory: ${reply.summary}`);
  process.exit(0);
}

if (command === "status") {
  const parsed = parseCommandOptions({});
  if (parsed.positionals.length > 0) fail(`status: unexpected positional "${parsed.positionals[0]}"`);

  const ledgerPath = join(stateDir, "ledger.jsonl");
  const events = readLedgerEvents(ledgerPath);
  if (events === null || events.length === 0) {
    console.log(`factory: no tasks yet (ledger: ${ledgerPath})`);
    process.exit(0);
  }
  for (const line of statusLines(events)) console.log(line);
  process.exit(0);
}

fail(`unknown command "${command}"`);

/**
 * Reads the ledger for `status` — the Owner's own data, read back directly;
 * no spool round trip, no plugin needed (ADR 0004 makes the plugin the only
 * writer, not the only reader).
 *
 * Forgiving of exactly the one thing the writer's fsync-per-line contract
 * forgives (ADR 0003): a last line with no trailing newline was never
 * acknowledged, so it is ignored here just as the core's open-time quarantine
 * ignores it — status never writes, so it cannot quarantine. Anything else
 * unreadable is reported (exit 2), never guessed around. Returns null when
 * the ledger does not exist yet (the plugin has never run on this home).
 */
function readLedgerEvents(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    die(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const events = [];
  const lines = raw.split("\n");
  lines.pop(); // the "" after a final newline — or the unacknowledged unterminated tail
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === "") return corruptLedger(path, `blank line at line ${i + 1}`);
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      return corruptLedger(path, `line ${i + 1} is not valid JSON`);
    }
    if (typeof evt !== "object" || evt === null) return corruptLedger(path, `line ${i + 1} is not a valid ledger event`);
    const attemptOk = evt.event === "contract_set" || (Number.isInteger(evt.attempt) && evt.attempt >= 1);
    if (!EVENT_NAMES.includes(evt.event) || typeof evt.task !== "string" || !attemptOk) {
      return corruptLedger(path, `line ${i + 1} is not a valid ledger event`);
    }
    events.push(evt);
  }
  return events;
}

/** One line per task, in first-appearance (ledger) order: the Owner's glance at the factory. */
function statusLines(events) {
  const order = [];
  const byTask = new Map();
  for (const evt of events) {
    let state = byTask.get(evt.task);
    if (state === undefined) {
      state = { attempts: 0, verdict: undefined, sha: undefined, accepted: false };
      byTask.set(evt.task, state);
      order.push(evt.task);
    }
    if (evt.event === "contract_set") continue; // the Contract belongs to the Task, not to an Attempt
    if (evt.attempt > state.attempts) state.attempts = evt.attempt;
    if (evt.event === "gate_finished") {
      state.verdict = evt.verdict; // the last verdict on record, even while a newer attempt runs
      state.sha = typeof evt.sha === "string" ? evt.sha.slice(0, 7) : undefined; // git's short length
    }
    if (evt.event === "attempt_accepted") state.accepted = true;
  }
  return order.map((task) => {
    const s = byTask.get(task);
    return `${task} attempts=${s.attempts} verdict=${s.verdict ?? "-"} sha=${s.sha ?? "-"} accepted=${s.accepted ? "yes" : "no"}`;
  });
}

function die(message) {
  console.error(`factory: ${message}`);
  process.exit(2);
}

function corruptLedger(path, reason) {
  die(`${path} is not a readable ledger: ${reason}`);
}
