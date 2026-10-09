#!/usr/bin/env node
/**
 * factory — the Owner's CLI (ADR 0002 / ADR 0004). Never placed on an agent's
 * PATH: setting the Contract and accepting an Attempt are the Owner's acts.
 *
 *   factory [--home <paseoHome>] contract --task <id> --workspace <dir> \
 *       --gate <command> --artifact <path> [--scope <p1,p2,...>] [--wait-secs <n>]
 *   factory [--home <paseoHome>] accept <task> --attempt <n> [--wait-secs <n>]
 *   factory [--home <paseoHome>] run <task> [<task>…] --provider <provider[/model>]
 *   factory [--home <paseoHome>] status
 *
 * contract and accept submit through the spool and wait for the plugin's
 * reply — the CLI never writes the ledger. run (v0.0.5) is the driver: per
 * task it submits a `spawn` request through the same spool (the plugin
 * ledgered `spawn_dispatched`/`spawn_refused` either way), creates the agent
 * over the daemon's own WebSocket RPC, and watches to verdict — the heavy
 * half lives in plugin/bin/driver.mjs. status is a local, read-only view
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
import { join, resolve as resolvePath } from "node:path";
import { readLedgerEvents } from "./ledger-read.mjs";
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
             [--watch]               mark the watch pass ON for this task
                                     (needs the copilot CLI usable on the
                                     daemon's PATH — the CLI carries the
                                     watch's auth, there is no key file;
                                     record-only, one watch_written line
                                     after EVERY verdict)
             [--description <text>]  the task's assignment in the Owner's words —
                                     the driver's brief carries it (v0.0.6)

  accept     Accept one green attempt of a task (the Owner's act)
             accept <task> --attempt <n>

  run        Run contracted tasks' agents to verdict (the driver, v0.0.5):
             one agent per task on the daemon, watched to its verdict.
             run <task> [<task>…] --provider <provider[/model]>
             The task count is the parallelism ceiling (no --parallel knob);
             arity ≥ 2 requires scoped contracts. The driver creates the
             branch named after the task, submits one spawn request per task
             through the spool, and exits 0 only when every task ended green
             with zero refusals. Each agent's brief carries its contract's
             --description, when one was set.

  retro      Run the Retro over the whole ledger, on demand (v0.0.7): the
             plugin builds the corpus digest, prompts the pinned copilot
             model, writes retro-<date>.md in the state dir, and appends one
             retro_written line. Whole-ledger always — no --since, no task
             filter (v1). One successful retro per UTC day; a same-day second
             run is refused (exit 2, no ledger line). Proposals are advice:
             nothing becomes law until the Owner ratifies it.
             retro [--wait-secs <n>]   (default 660 — the pass is minutes-long)

  status     Print one line per task from the ledger — attempts, last verdict,
             attested sha (short), accepted, last fresh-eyes outcome, and the
             task's choke counts (permit asks allowed / denied, git refusals
             bound to the task) — plus one trailing retro line when a retro
             ever ran. A local read; the plugin need not be running.

options:
  --home <paseoHome>   daemon home (default: $PASEO_HOME or ~/.paseo)
  --wait-secs <n>      how long to wait for the plugin's reply (default: 60;
                       retro waits 660 — the pass is minutes-long)`;

const DEFAULT_WAIT_SECS = 60;
/** The retro's own default — one pass runs minutes, and the budget alone is 600s. */
const RETRO_WAIT_SECS = 660;

// The event vocabulary the status reader understands — mirrored from
// src/events.ts because the CLIs import no src/ code (ADR 0004). Kept on one
// line so test/status.test.ts can guard this copy against drift. Kept in sync
// with the writer by the same suite, the way test/cli.test.ts guards the spool.
const EVENT_NAMES = ["contract_set", "claim_reported", "gate_started", "gate_finished", "fresh_eyes_written", "watch_written", "report_written", "attempt_accepted", "permit_allowed", "permit_denied", "git_blocked", "spawn_dispatched", "spawn_refused", "retro_written"];
// Events without an Attempt number: contract_set owns the Task, the choke
// events (v0.0.4) belong to the Task's whole life, git_blocked may carry no
// task at all (the shim refuses no matter who runs it), the spawn events
// (v0.0.5) precede any attempt — the plugin records them before an agent
// exists — and retro_written (v0.0.7) is factory-level: no task either.
const NO_ATTEMPT_EVENTS = new Set(["contract_set", "permit_allowed", "permit_denied", "git_blocked", "spawn_dispatched", "spawn_refused", "retro_written"]);

/**
 * The status reader's shape rule — every event is in the vocabulary above and
 * carries task/attempt per the NO_ATTEMPT rule. Handed to the shared reader
 * (ledger-read.mjs) as its strictness: a line failing it is corruption, named
 * with its line number.
 */
function isValidLedgerEvent(evt) {
  const taskOk = NO_ATTEMPT_EVENTS.has(evt.event) || typeof evt.task === "string";
  const attemptOk = NO_ATTEMPT_EVENTS.has(evt.event) || (Number.isInteger(evt.attempt) && evt.attempt >= 1);
  return EVENT_NAMES.includes(evt.event) && taskOk && attemptOk;
}

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

const home = resolveHome(homeFlag);
const stateDir = stateDirFor(home);
const spoolRoot = spoolRootFor(stateDir);

function parseCommandOptions(spec) {
  try {
    return parseArgs({ strict: true, args: rest, options: spec, allowPositionals: true });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

function waitSeconds(parsed, defaultSecs = DEFAULT_WAIT_SECS) {
  const raw = parsed.values["wait-secs"];
  if (raw === undefined) return defaultSecs;
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
    watch: { type: "boolean", default: false },
    description: { type: "string" },
    "wait-secs": { type: "string" },
  });
  const v = parsed.values;
  if (typeof v.task !== "string") fail("contract: --task is required");
  if (typeof v.workspace !== "string") fail("contract: --workspace is required");
  if (typeof v.gate !== "string") fail("contract: --gate is required");
  if (typeof v.artifact !== "string") fail("contract: --artifact is required");
  if (typeof v.description === "string" && v.description.trim() === "") {
    fail("contract: --description must be a non-empty text — omit it when the task has no assignment text");
  }
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
    ...(v.watch ? { watch: true } : {}),
    ...(v.description === undefined ? {} : { description: v.description }),
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

if (command === "run") {
  const parsed = parseCommandOptions({
    provider: { type: "string" },
    "wait-secs": { type: "string" },
  });
  const tasks = parsed.positionals;
  if (tasks.length === 0) fail("run: at least one task id is required (factory run <task> [<task>…] --provider <provider[/model]>)");
  const provider = parsed.values.provider;
  if (typeof provider !== "string" || provider.trim() === "") fail("run: --provider <provider[/model]> is required — one provider for every task in the invocation");
  const seen = new Set();
  for (const task of tasks) {
    if (seen.has(task)) fail(`run: task ${task} appears twice — one spawn per task per invocation`);
    seen.add(task);
  }

  const { runDriver } = await import("./driver.mjs");
  const code = await runDriver({
    home,
    stateDir,
    spoolRoot,
    tasks,
    provider: provider.trim(),
    waitSecs: waitSeconds(parsed),
  });
  process.exit(code);
}

if (command === "retro") {
  const parsed = parseCommandOptions({ "wait-secs": { type: "string" } });
  if (parsed.positionals.length > 0) fail(`retro: unexpected positional "${parsed.positionals[0]}" — the retro reads the whole ledger, there is nothing to name`);

  // No arguments ride the request: whole-ledger always (v1; no --since, no
  // task filter). The plugin builds the digest, runs the pass, writes the
  // proposals file and the one retro_written line; the reply's summary is
  // the proposal count and the file path (ticket 03 item 2).
  const reply = await roundTrip({ id: randomId(), kind: "retro" }, waitSeconds(parsed, RETRO_WAIT_SECS));
  console.log(`factory: ${reply.summary}`);
  process.exit(0);
}

if (command === "status") {
  const parsed = parseCommandOptions({});
  if (parsed.positionals.length > 0) fail(`status: unexpected positional "${parsed.positionals[0]}"`);

  // The Owner's own data, read back directly — no spool round trip, no plugin
  // needed (ADR 0004 makes the plugin the only writer, not the only reader).
  // The read is the shared one (ledger-read.mjs) under status's strict
  // policy; anything unreadable is reported (exit 2), never guessed around.
  const ledgerPath = join(stateDir, "ledger.jsonl");
  const read = readLedgerEvents(ledgerPath, { validateEvent: isValidLedgerEvent });
  if (read.failed !== undefined) {
    die(`cannot read ${ledgerPath}: ${read.failed instanceof Error ? read.failed.message : String(read.failed)}`);
  }
  if (read.corrupt !== undefined) corruptLedger(ledgerPath, read.corrupt);
  const events = read.missing ? null : read.events;
  if (events === null || events.length === 0) {
    console.log(`factory: no tasks yet (ledger: ${ledgerPath})`);
    process.exit(0);
  }
  for (const line of statusLines(events)) console.log(line);
  process.exit(0);
}

fail(`unknown command "${command}"`);

/** One line per task, in first-appearance (ledger) order — the Owner's glance at the factory. */
function statusLines(events) {
  const order = [];
  const byTask = new Map();
  let retro;
  for (const evt of events) {
    if (evt.event === "retro_written") {
      // The one factory-level event (v0.0.7): it belongs to no task line —
      // the last retro on record prints once, after every task.
      retro = evt;
      continue;
    }
    if (evt.event !== "contract_set" && NO_ATTEMPT_EVENTS.has(evt.event)) {
      // The choke events (v0.0.4) carry no Attempt: they count toward their
      // task's line — a live Contract always precedes them in the ledger — and
      // an untasked git block counts toward no line at all. The spawn events
      // (v0.0.5) ride the ledger as the spawn record itself: validated and read
      // through, counted toward no field — the driver's output and the ledger
      // name refusals, the glance does not repeat them.
      const counted = byTask.get(evt.task);
      if (counted !== undefined) {
        if (evt.event === "permit_allowed") counted.allowed += 1;
        else if (evt.event === "permit_denied") counted.denied += 1;
        else if (evt.event === "git_blocked") counted.blocked += 1;
      }
      continue;
    }
    let state = byTask.get(evt.task);
    if (state === undefined) {
      state = { attempts: 0, verdict: undefined, sha: undefined, eye: undefined, accepted: false, allowed: 0, denied: 0, blocked: 0 };
      byTask.set(evt.task, state);
      order.push(evt.task);
    }
    if (evt.event === "contract_set") continue; // the Contract registers its Task's line, but never counts as an Attempt
    if (evt.attempt > state.attempts) state.attempts = evt.attempt;
    if (evt.event === "gate_finished") {
      state.verdict = evt.verdict; // the last verdict on record, even while a newer attempt runs
      state.sha = typeof evt.sha === "string" ? evt.sha.slice(0, 7) : undefined; // git's short length
    }
    if (evt.event === "fresh_eyes_written") {
      state.eye = typeof evt.outcome === "string" ? evt.outcome : undefined; // the last eye on record
    }
    if (evt.event === "attempt_accepted") state.accepted = true;
  }
  const lines = order.map((task) => {
    const s = byTask.get(task);
    return `${task} attempts=${s.attempts} verdict=${s.verdict ?? "-"} sha=${s.sha ?? "-"} accepted=${s.accepted ? "yes" : "no"} eye=${s.eye ?? "-"} choke=${s.allowed}/${s.denied}/${s.blocked}`;
  });
  if (retro !== undefined) {
    const day = typeof retro.ts === "string" ? retro.ts.slice(0, 10) : "-";
    const count = retro.outcome === "written" && Number.isInteger(retro.proposalCount) ? ` proposals=${retro.proposalCount}` : "";
    lines.push(`retro last=${day} outcome=${retro.outcome ?? "-"}${count}`);
  }
  return lines;
}

function die(message) {
  console.error(`factory: ${message}`);
  process.exit(2);
}

function corruptLedger(path, reason) {
  die(`${path} is not a readable ledger: ${reason}`);
}
