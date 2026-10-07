#!/usr/bin/env node
/**
 * factory — the Owner's CLI (ADR 0002 / ADR 0004). Never placed on an agent's
 * PATH: setting the Contract and accepting an Attempt are the Owner's acts.
 *
 *   factory [--home <paseoHome>] contract --task <id> --workspace <dir> \
 *       --gate <command> --artifact <path> [--scope <p1,p2,...>] [--wait-secs <n>]
 *   factory [--home <paseoHome>] accept <task> --attempt <n> [--wait-secs <n>]
 *
 * Both commands submit through the spool and wait for the plugin's reply —
 * the CLI never touches the ledger. The home defaults to `PASEO_HOME` or
 * `~/.paseo`; against the trial daemon pass `--home ~/.paseo-factory`.
 *
 * Exit codes: 0 the command succeeded · 2 it did not (bad usage, rejected by
 * the factory, or no reply from the plugin).
 */
import { parseArgs } from "node:util";
import { resolve as resolvePath } from "node:path";
import { awaitReply, randomId, resolveHome, spoolRootFor, stateDirFor, submit } from "./spool-client.mjs";

const usage = `usage: factory [--home <paseoHome>] <command> [options]

commands:
  contract   Set a task's done-criteria (the Owner's act — fixed before the
             agent starts; one contract per task id, the ledger is append-only)
             --task <id> --workspace <dir> --gate <command> --artifact <path>
             [--scope <p1,p2,...>]   workspace-relative prefixes the task may touch

  accept     Accept one green attempt of a task (the Owner's act)
             accept <task> --attempt <n>

options:
  --home <paseoHome>   daemon home (default: $PASEO_HOME or ~/.paseo)
  --wait-secs <n>      how long to wait for the plugin's reply (default: 60)`;

const DEFAULT_WAIT_SECS = 60;

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
    ...(v.scope === undefined ? {} : { scope: v.scope.split(",").map((s) => s.trim()).filter((s) => s !== "") }),
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

fail(`unknown command "${command}"`);
