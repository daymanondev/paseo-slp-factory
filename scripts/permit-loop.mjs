#!/usr/bin/env node
/**
 * permit-loop — absorb the "Always Ask" permit parade of one spawned agent
 * (retro 2026-10-08, item 3; both live runs so far hand-rolled this loop).
 * Polls `paseo permit ls --json` and allows each pending request belonging to
 * --agent, one stdout line per grant, so the run's permit count falls out of
 * the log (`grep -c ALLOWED`). Plain node, zero runtime deps.
 *
 * Usage: node scripts/permit-loop.mjs --home <home> --agent <id> [options]
 * (options: --max-mins, --interval-ms, --paseo, --once — see --help)
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const USAGE = `usage: node scripts/permit-loop.mjs --home <home> --agent <id> [options]
  --home <path>     daemon home (required; default ~/.paseo is PROD, refused)
  --agent <id>      agent id or prefix to allow for (required)
  --max-mins <n>    stop after n minutes (default 30, fractions allowed)
  --interval-ms <n> poll interval in ms (default 5000, min 100)
  --paseo <path>    paseo binary (default: PATH, then ~/.local/bin/paseo)
  --once            poll once, then exit`;

const fail = (message, { withUsage = true } = {}) => {
  console.error(`permit-loop: ${message}`);
  if (withUsage) console.error(USAGE);
  process.exit(2);
};

// ---- args ---------------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { home: undefined, agent: undefined, maxMins: 30, intervalMs: 5000, paseo: undefined, once: false };
  const valueFlags = new Map([
    ["--home", "home"],
    ["--agent", "agent"],
    ["--max-mins", "maxMins"],
    ["--interval-ms", "intervalMs"],
    ["--paseo", "paseo"],
  ]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    if (arg === "--once") {
      opts.once = true;
      continue;
    }
    const key = valueFlags.get(arg);
    if (key === undefined) fail(`unknown option "${arg}"`);
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) fail(`"${arg}" needs a value`);
    opts[key] = value;
  }
  if (opts.home === undefined) fail("--home is required");
  if (opts.agent === undefined || opts.agent === "") fail("--agent is required");
  opts.maxMins = Number(opts.maxMins);
  if (!Number.isFinite(opts.maxMins) || opts.maxMins <= 0) fail("--max-mins must be a positive number");
  opts.intervalMs = Number(opts.intervalMs);
  if (!Number.isInteger(opts.intervalMs) || opts.intervalMs < 100) fail("--interval-ms must be an integer >= 100");
  return opts;
}

const expandTilde = (path) => {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
};

function resolvePaseo(flagged) {
  if (flagged !== undefined) {
    if (!existsSync(flagged)) fail(`--paseo ${flagged}: not found`);
    return flagged;
  }
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir === "") continue;
    const candidate = join(dir, "paseo");
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // not on this PATH entry
    }
  }
  const fallback = join(homedir(), ".local", "bin", "paseo");
  if (existsSync(fallback)) return fallback;
  fail("paseo not found — pass --paseo <path> (non-interactive shells lack ~/.local/bin)");
}

// ---- the loop ------------------------------------------------------------------------------

/** An entry matches when the arg is the full agentId or a prefix of either id form (paseo's own rule). */
function matchesAgent(entry, arg) {
  const id = typeof entry.agentId === "string" ? entry.agentId : "";
  const short = typeof entry.agentShortId === "string" ? entry.agentShortId : "";
  return id === arg || id.startsWith(arg) || (short !== "" && short.startsWith(arg));
}

const clock = () => new Date().toISOString().slice(11, 19);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const home = expandTilde(opts.home);
  const defaultHome = join(homedir(), ".paseo");
  if (home === defaultHome) {
    fail("refusing --home ~/.paseo — that is the DEFAULT home and it is PROD; point at the trial home ~/.paseo-factory", { withUsage: false });
  }
  const paseo = resolvePaseo(opts.paseo);
  const callPaseo = (args) => spawnSync(paseo, [...args, "--home", home], { encoding: "utf8", timeout: 10_000 });

  console.log(`permit-loop: home=${home} agent=${opts.agent} paseo=${paseo} interval=${opts.intervalMs}ms`);

  const deadline = Date.now() + opts.maxMins * 60_000;
  const startedAt = Date.now();
  let interrupted = false;
  process.on("SIGINT", () => {
    interrupted = true;
  });

  let grants = 0;
  let polls = 0;
  while (!interrupted && (opts.once || Date.now() < deadline)) {
    polls += 1;
    const listing = callPaseo(["permit", "ls", "--json"]);
    if (listing.status !== 0) {
      console.error(`WARN poll ${clock()}: permit ls exited ${listing.status}: ${(listing.stderr ?? "").trim().slice(0, 120)}`);
    } else {
      let pending = [];
      try {
        const parsed = JSON.parse((listing.stdout ?? "").trim());
        if (!Array.isArray(parsed)) throw new Error("not an array");
        pending = parsed;
      } catch {
        console.error(`WARN poll ${clock()}: unparseable permit ls output: ${(listing.stdout ?? "").trim().slice(0, 60)}`);
      }
      for (const entry of pending) {
        if (typeof entry?.id !== "string" || !matchesAgent(entry, opts.agent)) continue;
        const allowed = callPaseo(["permit", "allow", opts.agent, entry.id]);
        if (allowed.status === 0) {
          grants += 1;
          console.log(`${clock()} ALLOWED ${entry.name ?? "?"} ${entry.agentShortId ?? opts.agent} ${entry.id}`);
        } else {
          console.error(`WARN ${clock()} ALLOW-FAILED ${entry.name ?? "?"} ${entry.id}: ${(allowed.stderr ?? "").trim().slice(0, 120)}`);
        }
      }
    }
    if (opts.once || interrupted) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(opts.intervalMs, remaining));
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`permit-loop: grants=${grants} polls=${polls} elapsed=${elapsed}s`);
  if (interrupted) process.exit(130);
}

await main();
