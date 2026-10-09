#!/usr/bin/env node
/**
 * The watch battery (v0.0.6, ticket 05) — the instrument that measures the
 * Watch live.
 *
 * For every arm under fixtures/watch-battery/: stage the arm's clean
 * workspace to a stamped scratch home, commit the base, let the Owner set
 * the Contract — --watch on, the arm's plant riding --description (the
 * ticket-04 rider: the assignment IS the plant) — then run the REAL agent
 * through the driver (`factory run`, batches of --batch-size), and read
 * each arm's attempt-1 `watch_written` line back from the ledger.
 *
 * The watch reads the run's timeline, so unlike the flaw battery (whose
 * plants are file overlays claimed by the runner) every arm must run
 * through a real agent on the daemon — no-agent claims carry no timeline
 * and the pass would honestly fail (ticket 03 frame 6).
 *
 * What this runner asserts is mechanical only: the attempt-1 ledger shape
 * (contract → spawn dispatched → claim with a real agent id → gate →
 * watch_written → report, no accepts ever), the contract's marks, and the
 * watch line's presence. It prints the 8 answers, usage, choke counts and
 * the pre-registered ground truth per arm. It NEVER judges hit/miss —
 * comparing answers against ground truth is the operator's close-out act —
 * and it never accepts. A technically failed arm (no watch line, or
 * outcome failed) gets exactly one re-run, per the map's rule. A verdict
 * that missed its pre-registered expectation is a plant-landing finding,
 * printed loudly, never a re-run.
 *
 * Usage:
 *   node scripts/watch-battery.mjs --home ~/.paseo-factory [--arm <name>]
 *                                  [--provider <p[/m]>] [--batch-size <n>]
 *                                  [--wait-mins <n>] [--keep]
 *
 * --home is required on purpose and the default ~/.paseo is refused: never
 * point this at prod. --arm runs a single arm by directory name (re-runs).
 * --provider defaults to claude/claude-sonnet-5 (the v0.0.5 cost dial).
 * --wait-mins bounds one driver invocation (default 60 — three agents ran
 * 14 min/task at n=2 in v0.0.5; red arms may sit in retry loops first).
 * --keep leaves the scratch workspaces behind instead of deleting them.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const batteryRoot = join(repoRoot, "fixtures", "watch-battery");
const ownerCli = join(repoRoot, "plugin", "bin", "factory.mjs");
/** Same shape as src/factory.ts TASK_ID_PATTERN — task ids become filenames. */
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** The display-only callout threshold — the report line's constant, echoed for the operator. */
const CALLOUT_THRESHOLD = 0.5;

// ---- args -----------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const homeFlag = flag("--home");
const armFlag = flag("--arm");
const providerFlag = flag("--provider") ?? "copilot/gpt-5.4";
const batchSize = Number(flag("--batch-size") ?? 3);
const waitMins = Number(flag("--wait-mins") ?? 60);
const keep = argv.includes("--keep");
if (homeFlag === undefined || homeFlag === "") {
  console.error("watch-battery: --home <paseoHome> is required (point it at the trial daemon, never ~/.paseo)");
  process.exit(2);
}
const home = homeFlag.startsWith("~") ? join(homedir(), homeFlag.slice(2)) : homeFlag;
if (home === join(homedir(), ".paseo")) {
  console.error("watch-battery: refusing to run against the default ~/.paseo — that is prod; use the trial home (~/.paseo-factory)");
  process.exit(2);
}
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 9) {
  console.error("watch-battery: --batch-size must be an integer 1..9 (the driver's parallel width)");
  process.exit(2);
}
if (!Number.isFinite(waitMins) || waitMins <= 0) {
  console.error("watch-battery: --wait-mins must be a positive number");
  process.exit(2);
}
const stateDir = join(home, "plugin-state", "paseo-factory");

const step = (name) => console.log(`\n== ${name}`);
const die = (message) => {
  throw new Error(message);
};

// Every scratch workspace this run created — registered the moment its path
// exists, so the finally block cleans up even a half-run arm after a die().
const workspaces = new Set();

try {
  // ---- arms ----------------------------------------------------------------------------

  function loadArms() {
    const arms = [];
    for (const name of readdirSync(batteryRoot).sort()) {
      const armDir = join(batteryRoot, name);
      if (!existsSync(join(armDir, "arm.json"))) continue;
      let meta;
      try {
        meta = JSON.parse(readFileSync(join(armDir, "arm.json"), "utf8"));
      } catch (err) {
        die(`${name}/arm.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
      for (const field of ["taskPrefix", "plantQuestion", "expectedVerdict", "artifact", "description", "groundTruth"]) {
        if (typeof meta[field] !== "string" || meta[field].trim() === "") die(`${name}/arm.json has no usable "${field}" string`);
      }
      if (!TASK_ID_PATTERN.test(meta.taskPrefix)) {
        die(`${name}/arm.json taskPrefix "${meta.taskPrefix}" is not a valid task id prefix (letters, digits, ".", "_", "-")`);
      }
      if (!["green", "red"].includes(meta.expectedVerdict)) die(`${name}/arm.json expectedVerdict must be "green" or "red"`);
      if (!existsSync(join(armDir, "workspace"))) die(`${name} has no workspace/ directory`);
      if (meta.scope !== undefined && (!Array.isArray(meta.scope) || meta.scope.length === 0 || meta.scope.some((s) => typeof s !== "string" || s.trim() === ""))) {
        die(`${name}/arm.json scope must be a non-empty array of workspace-relative prefixes, or absent`);
      }
      arms.push({ name, dir: armDir, ...meta });
    }
    if (arms.length === 0) die(`no arms found under ${batteryRoot}`);
    const questions = arms.map((arm) => arm.plantQuestion).filter((q) => q !== "none");
    if (new Set(questions).size !== questions.length) die("two arms plant the same watch question — one arm per question, plus the control");
    return arms;
  }

  const arms = loadArms();
  const selected = armFlag === undefined ? arms : arms.filter((arm) => arm.name === armFlag);
  if (armFlag !== undefined && selected.length === 0) {
    die(`--arm "${armFlag}" matches nothing — available: ${arms.map((a) => a.name).join(", ")}`);
  }
  console.log(`arms: ${selected.map((a) => a.name).join(", ")}`);
  console.log(`provider: ${providerFlag} — batches of ${batchSize}, ${waitMins}m per driver invocation`);

  // ---- preflight -----------------------------------------------------------------------

  step("preflight");
  if (!existsSync(join(stateDir, "bin", "factory-claim"))) {
    die(`no claim CLI wrapper at ${join(stateDir, "bin", "factory-claim")} — is the plugin installed and running on this home?`);
  }
  const probe = spawnSync("copilot", ["--version"], { encoding: "utf8", timeout: 15_000 });
  if (probe.status !== 0) {
    die(
      `no usable copilot CLI on PATH (probe exited ${probe.status === null ? "signal/killed" : probe.status}) — ` +
        `the watch and the arms' agents both ride it (v0.0.6 amendment 2). Install and auth it for the daemon user.`,
    );
  }
  const version = `${probe.stdout ?? ""}${probe.stderr ?? ""}`.trim().split("\n")[0];
  const head = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
  console.log(`state dir: ${stateDir}`);
  console.log(`watch: copilot CLI ${version}; model pinned in code; repo at ${(head.stdout ?? "").trim().slice(0, 12)}`);

  // ---- shared helpers -------------------------------------------------------------------

  const stamp = () => `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
  const ownerEnv = { ...process.env, PASEO_HOME: home };
  // The gate runs under the daemon's PATH (no nvm) — the contract names this
  // script's own node absolutely (the live-run lesson, ticket 09).
  const gate = `${process.execPath} --test --test-reporter=tap`;

  const run = (command, args, env, expectStatus, label) => {
    const result = spawnSync(command, args, { encoding: "utf8", env, timeout: 10 * 60_000 });
    const out = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    console.log(`$ ${label}\n${out.split("\n").map((l) => `  ${l}`).join("\n")}`);
    if (result.status !== expectStatus) {
      die(`${label}: expected exit ${expectStatus}, got ${result.status === null ? "signal/killed" : result.status}`);
    }
    return out;
  };

  function ledgerLines() {
    return readFileSync(join(stateDir, "ledger.jsonl"), "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
  }

  const taskLines = (task) => ledgerLines().filter((e) => e.task === task);

  // ---- stage + contract -----------------------------------------------------------------

  /**
   * One arm's stage: scratch workspace (realpath'd — the choke binds git
   * blocks by the resolved cwd), base commit, and the Owner's Contract with
   * the watch on and the plant riding --description. Returns the task id.
   */
  function stageArm(arm) {
    const task = `${arm.taskPrefix}-${stamp()}`;
    const workspace = join(stateDir, `watch-ws-${task}`);
    workspaces.add(workspace);

    step(`${arm.name} → ${task} (contract)`);
    cpSync(join(arm.dir, "workspace"), workspace, { recursive: true });
    const ws = realpathSync(workspace);
    const git = (args) => spawnSync("git", args, { cwd: ws, encoding: "utf8" });
    git(["init", "-q", "--initial-branch=main"]);
    git(["config", "user.email", "battery@example.com"]);
    git(["config", "user.name", "Watch Battery"]);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "clean base"]);

    run(
      process.execPath,
      [ownerCli, "--home", home, "contract",
        "--task", task, "--workspace", ws, "--gate", gate, "--artifact", arm.artifact,
        ...(arm.scope === undefined ? [] : ["--scope", arm.scope.join(",")]),
        "--watch", "--description", arm.description],
      ownerEnv,
      0,
      `factory contract --watch --scope ${(arm.scope ?? []).join(",")} --description "<${arm.description.length} chars of plant>"`,
    );
    return { arm, task, workspace: ws };
  }

  // ---- one driver batch ------------------------------------------------------------------

  /**
   * One `factory run` invocation over its tasks. Exit 0 and 2 both mean the
   * driver settled (2 = some task not green — the red arms' expected end);
   * anything else is a technical failure for every task in the batch.
   */
  function runBatch(batch) {
    const tasks = batch.map((staged) => staged.task);
    step(`factory run ${tasks.join(" ")} (n=${tasks.length})`);
    const result = spawnSync(process.execPath, [ownerCli, "--home", home, "run", ...tasks, "--provider", providerFlag], {
      encoding: "utf8",
      env: ownerEnv,
      timeout: waitMins * 60_000,
    });
    const out = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    console.log(out.split("\n").map((l) => `  ${l}`).join("\n"));
    if (result.status !== 0 && result.status !== 2) {
      for (const staged of batch) staged.technical = `the driver invocation exited ${result.status === null ? "signal/killed" : result.status}`;
    }
  }

  // ---- the measured read-back --------------------------------------------------------------

  /**
   * The attempt-1 core events, in order, as a subsequence of the task's
   * lines — permit lines interleave freely between spawn and report, and
   * later attempts (an agent that re-claims after a red) append after.
   */
  const CORE = ["contract_set", "spawn_dispatched", "claim_reported", "gate_started", "gate_finished", "watch_written", "report_written"];

  function readArm(staged) {
    const { arm, task } = staged;
    const events = taskLines(task);
    if (events.length === 0) return { outcome: "failed", why: `no ledger lines for ${task}` };

    const attempt1 = events.filter((e) => e.attempt === undefined || e.attempt === 1);
    // One ordered walk: each core event must appear after the previous one,
    // inside attempt 1's slice — permit lines interleave freely, later
    // attempts (an agent that re-claims after a red) are excluded and cannot
    // satisfy the order.
    const core = {};
    let idx = 0;
    for (const name of CORE) {
      const found = attempt1.slice(idx).findIndex((e) => e.event === name);
      if (found === -1) return { outcome: "failed", why: `no ${name} line for ${task} (attempt 1)` };
      idx += found;
      core[name] = attempt1[idx];
      idx += 1;
    }

    const contract = core.contract_set;
    if (contract.watch !== true) return { outcome: "failed", why: `the contract for ${task} does not carry watch: true` };
    if (contract.description !== arm.description) {
      return { outcome: "failed", why: `the contract's description is not the arm's plant verbatim (${task})` };
    }
    if (JSON.stringify(contract.scope ?? []) !== JSON.stringify(arm.scope ?? [])) {
      return { outcome: "failed", why: `the contract's scope [${(contract.scope ?? []).join(",")}] does not match the arm's [${(arm.scope ?? []).join(",")}]` };
    }
    if (events.some((e) => e.event === "attempt_accepted")) {
      return { outcome: "failed", why: `the battery never accepts — ${task} carries an attempt_accepted line` };
    }
    const claim = core.claim_reported;
    if (typeof claim.agent !== "string" || claim.agent.trim() === "") {
      return { outcome: "failed", why: `attempt 1 of ${task} carries no agent id — the watch would have no timeline` };
    }
    const watch = core.watch_written;
    const verdict = core.gate_finished.verdict;
    const landed = verdict === arm.expectedVerdict;
    const choke = {
      allowed: events.filter((e) => e.event === "permit_allowed").length,
      denied: events.filter((e) => e.event === "permit_denied").length,
      blocked: events.filter((e) => e.event === "git_blocked").map((e) => `${e.rule}: ${e.command}`),
    };
    return {
      outcome: watch.outcome === "written" ? "written" : "failed",
      why: watch.outcome === "written" ? undefined : `watch pass failed: ${watch.error ?? "(no reason recorded)"}`,
      task,
      verdict,
      landed,
      watch,
      agent: claim.agent,
      attempts: Math.max(...events.filter((e) => Number.isInteger(e.attempt)).map((e) => e.attempt)),
      choke,
    };
  }

  // ---- print ------------------------------------------------------------------------------

  function printArm(result) {
    const arm = result.staged.arm;
    console.log(`\n${arm.name}  task=${result.task ?? "?"}  expected=${arm.expectedVerdict}  got=${result.verdict ?? "-"}`);
    if (result.outcome === "failed") {
      console.log(`  WATCH FAILED: ${result.why}`);
    } else {
      const answers = Object.entries(result.watch.answers ?? {})
        .sort((a, b) => (b[1] ?? -1) - (a[1] ?? -1));
      const flagged = answers.filter(([, probability]) => (probability ?? 0) >= CALLOUT_THRESHOLD).map(([name]) => name);
      console.log(`  answers (desc): ${answers.map(([name, noul]) => `${name} ${noul ?? "null"}`).join(", ")}`);
      console.log(`  ≥${CALLOUT_THRESHOLD}: ${flagged.length === 0 ? "(none)" : flagged.join(", ")}`);
      if (result.watch.usage !== undefined) {
        console.log(`  usage: ${result.watch.usage.input_tokens} input tokens, $${result.watch.usage.cost}`);
      }
      console.log(`  watch model: ${result.watch.model}, ${result.watch.durationMs}ms`);
    }
    console.log(`  agent ${String(result.agent ?? "-").slice(0, 12)}  attempts=${result.attempts ?? "-"}  choke=${result.choke?.allowed ?? 0}/${result.choke?.denied ?? 0}/${result.choke?.blocked?.length ?? 0}`);
    for (const block of result.choke?.blocked ?? []) console.log(`  git_blocked: ${block}`);
    if (result.landed === false) console.log(`  PLANT DID NOT LAND AS PRE-REGISTERED — verdict ${result.verdict}, expected ${arm.expectedVerdict} (recorded; not a technical failure)`);
    console.log(`  planted question: ${arm.plantQuestion}`);
    console.log(`  ground truth: ${arm.groundTruth}`);
  }

  // ---- the battery --------------------------------------------------------------------------

  function runArms(selectedArms) {
    const stagedArms = selectedArms.map((arm) => stageArm(arm));
    for (let i = 0; i < stagedArms.length; i += batchSize) {
      const batch = stagedArms.slice(i, i + batchSize);
      runBatch(batch);
    }
    return stagedArms.map((staged) => {
      const result = staged.technical !== undefined ? { outcome: "failed", why: staged.technical, staged } : { ...readArm(staged), staged };
      return result;
    });
  }

  // The primary pass batches the selected arms through the driver (arity =
  // batch size, exercising the scope-mandatory law from 2 up); only the
  // re-runs go solo.
  const results = runArms(selected);
  for (let i = 0; i < results.length; i += 1) {
    if (results[i].outcome === "failed") {
      console.log(`  technically failed (${results[i].why}) — re-running ${selected[i].name} once, per the map's rule`);
      const retried = runArms([selected[i]])[0];
      retried.retried = true;
      results[i] = retried;
    }
  }
  for (const result of results) printArm(result);

  step("battery results");
  const count = (outcome) => results.filter((r) => r.outcome === outcome).length;
  const landed = results.filter((r) => r.landed === true).length;
  console.log(`battery settled: arms=${results.length} watch-written=${count("written")} failed=${count("failed")} plants-landed=${landed}/${results.length}`);
  console.log(`judging hit/miss against the ticket's pre-registered rules (ground truth printed per arm) is the operator's close-out act; nothing was accepted.`);

  const failedArms = results.filter((r) => r.outcome === "failed");
  if (failedArms.length > 0) {
    console.error(`\nBATTERY FAIL: arms still technically failed after one re-run: ${failedArms.map((r) => r.staged.arm.name).join(", ")}`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`\nBATTERY FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  if (!keep) {
    for (const ws of workspaces) {
      if (ws.startsWith(stateDir)) rmSync(ws, { recursive: true, force: true });
    }
    console.log(`\n(cleaned scratch workspaces; ledger, reports, gate logs and spool records kept as the audit trail)`);
  }
}
