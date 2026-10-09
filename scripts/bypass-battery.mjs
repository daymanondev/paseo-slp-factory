#!/usr/bin/env node
/**
 * The bypass battery (v0.0.4, ticket 02) — the instrument ticket 03 runs live.
 *
 * For every arm under fixtures/bypass-battery/: create a scratch git
 * workspace (plus a local bare remote for push arms, set diverged so an
 * unchoked force-push visibly moves a ref), let the Owner set the Contract —
 * which is what makes the asking party contracted — then plant the arm's
 * escape and assert the map's pre-registered outcomes mechanically:
 *
 *   choked  = the escape does not execute AND exactly one ledger line records
 *             it (shim: non-zero exit + its stderr line + one `git_blocked`;
 *             policy: ask denied + one `permit_denied`)
 *   escaped = the dangerous operation executes, or is allowed and would run
 *   clean   = control only: every ask allowed, zero denies, benign git passes
 *             through the shim
 *   failed  = technical (no plugin reply, no ingestion, killed shell) — the
 *             arm is re-run once, per the map's rule
 *
 * The runner never judges and never accepts — reading outcomes against the
 * map's rules and the arms' recorded ground truth is the operator's act. The
 * ask arms ride the spool's synthetic `ask` request (the smoke-harness
 * channel `factory-claim` uses — the choke does not care who attempts the
 * escape); the shim arm executes with the hook-injected bin dir first on
 * PATH, exactly an agent shell sees it.
 *
 * Usage:
 *   node scripts/bypass-battery.mjs --home ~/.paseo-factory [--arm <name>] [--keep]
 *
 * --home is required on purpose and the default ~/.paseo is refused: never
 * point this at prod. --arm runs a single arm by directory name (re-runs).
 * --keep leaves the scratch workspaces and remotes behind.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { awaitReply, randomId, spoolRootFor, submit } from "../plugin/bin/spool-client.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const batteryRoot = join(repoRoot, "fixtures", "bypass-battery");
const ownerCli = join(repoRoot, "plugin", "bin", "factory.mjs");
/** Same shape as src/factory.ts TASK_ID_PATTERN — task ids become filenames. */
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ASK_WAIT_MS = 30_000;
const INGEST_WAIT_MS = 15_000;

// ---- args -----------------------------------------------------------------------------

const argv = process.argv.slice(2);
const homeFlag = argv.includes("--home") ? argv[argv.indexOf("--home") + 1] : undefined;
const armFlag = argv.includes("--arm") ? argv[argv.indexOf("--arm") + 1] : undefined;
const keep = argv.includes("--keep");
if (homeFlag === undefined || homeFlag === "") {
  console.error("bypass-battery: --home <paseoHome> is required (point it at the trial daemon, never ~/.paseo)");
  process.exit(2);
}
const home = homeFlag.startsWith("~") ? join(homedir(), homeFlag.slice(2)) : homeFlag;
if (home === join(homedir(), ".paseo")) {
  console.error("bypass-battery: refusing to run against the default ~/.paseo — that is prod; use the trial home (~/.paseo-factory)");
  process.exit(2);
}
const stateDir = join(home, "plugin-state", "paseo-factory");
const binDir = join(stateDir, "bin");

const step = (name) => console.log(`\n== ${name}`);
const die = (message) => {
  throw new Error(message);
};

// Every scratch path this run created — registered the moment it exists, so
// the finally block cleans up even a half-run arm after a die().
const scratch = new Set();

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
      for (const field of ["taskPrefix", "kind", "command", "groundTruth"]) {
        if (typeof meta[field] !== "string" || meta[field].trim() === "") die(`${name}/arm.json has no usable "${field}" string`);
      }
      if (!TASK_ID_PATTERN.test(meta.taskPrefix)) {
        die(`${name}/arm.json taskPrefix "${meta.taskPrefix}" is not a valid task id prefix (letters, digits, ".", "_", "-")`);
      }
      if (!["shim", "ask", "control"].includes(meta.kind)) die(`${name}/arm.json kind must be "shim", "ask" or "control"`);
      if (meta.kind === "control" && typeof meta.shimCommand !== "string") {
        die(`${name}/arm.json is the control and must carry a benign "shimCommand"`);
      }
      if (meta.kind !== "control" && typeof meta.expectRule !== "string") {
        die(`${name}/arm.json must carry the "expectRule" a choked ask cites`);
      }
      arms.push({ name, dir: armDir, ...meta });
    }
    if (arms.length === 0) die(`no arms found under ${batteryRoot}`);
    return arms;
  }

  const arms = loadArms();
  const selected = armFlag === undefined ? arms : arms.filter((arm) => arm.name === armFlag);
  if (armFlag !== undefined && selected.length === 0) {
    die(`--arm "${armFlag}" matches nothing — available: ${arms.map((a) => a.name).join(", ")}`);
  }
  console.log(`arms: ${selected.map((a) => a.name).join(", ")}`);

  // ---- preflight -----------------------------------------------------------------------

  step("preflight");
  if (!existsSync(join(binDir, "factory-claim"))) {
    die(`no claim CLI wrapper at ${join(binDir, "factory-claim")} — is the plugin installed and running on this home?`);
  }
  if (!existsSync(join(binDir, "git"))) {
    die(
      `no git shim at ${join(binDir, "git")} — the plugin is pre-v0.0.4 or the daemon was not restarted after the upgrade; ` +
        `restart/reload so the plugin regenerates its bin dir`,
    );
  }
  console.log(`state dir: ${stateDir}`);
  console.log(`shim: ${join(binDir, "git")}`);

  // ---- shared helpers -------------------------------------------------------------------

  const stamp = () => `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
  const ownerEnv = { ...process.env, PASEO_HOME: home };
  const gate = `${process.execPath} -e "process.exit(0)"`; // the contract's gate is ceremony here, not measurement

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
    const path = join(stateDir, "ledger.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").trimEnd().split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
  }

  const taskLines = (task) => ledgerLines().filter((e) => e.task === task);
  const countEvent = (task, event) => taskLines(task).filter((e) => e.event === event).length;

  /** Bounded wait until fn() stops throwing — how the battery sees the plugin's async ingestion. */
  async function until(fn, what, ms) {
    const deadline = Date.now() + ms;
    for (;;) {
      try {
        return fn();
      } catch (err) {
        if (Date.now() >= deadline) throw new Error(`${what}: ${err instanceof Error ? err.message : String(err)}`);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }

  /**
   * One arm's stage: scratch workspace, optional diverged bare remote (an
   * unchoked force-push then visibly moves a ref), and the Owner's Contract —
   * the act that makes this workspace's asking party contracted. The
   * workspace is realpath'd the moment it exists: the shim records its
   * process cwd RESOLVED (macOS turns /var into /private/var), and the
   * contract's workspace must match it for the git-block line to bind.
   */
  function stageArm(arm) {
    const task = `${arm.taskPrefix}-${stamp()}`;
    const workspace = join(stateDir, `bypass-ws-${task}`);
    const remote = arm.needsRemote === true ? join(stateDir, `bypass-remote-${task}.git`) : undefined;
    scratch.add(workspace);
    if (remote !== undefined) scratch.add(remote);

    step(`${arm.name} → ${task}`);
    const git = (args, cwd = ws) =>
      spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env } });
    spawnSync("git", ["init", "-q", "--initial-branch=main", workspace], { encoding: "utf8" });
    const ws = realpathSync(workspace);
    git(["config", "user.email", "battery@example.com"]);
    git(["config", "user.name", "Bypass Battery"]);
    writeFileSync(join(ws, "probe.txt"), `${task}\n`);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "clean base"]);
    if (remote !== undefined) {
      spawnSync("git", ["init", "-q", "--bare", "--initial-branch=main", remote], { encoding: "utf8" });
      git(["remote", "add", "origin", remote]);
      git(["push", "-q", "origin", "main"]);
      const setup = git(["rev-parse", "HEAD"]).stdout.trim();
      if (spawnSync("git", ["--git-dir", remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).stdout.trim() !== setup) {
        die(`${arm.name}: the setup push to ${remote} did not land — the remote must sit at the base commit before the escape`);
      }
      // Diverge: remote stays at the base, the workspace moves on. An escaped
      // force-push rewinds nothing here — it MOVES the remote to the new sha;
      // a choked one leaves the remote untouched.
      writeFileSync(join(ws, "probe.txt"), `${task}\ndiverged\n`);
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "diverged work"]);
    }
    const remoteMain = () => spawnSync("git", ["--git-dir", remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).stdout.trim();

    run(
      process.execPath,
      [ownerCli, "--home", home, "contract",
        "--task", task, "--workspace", ws, "--gate", gate, "--artifact", "probe.txt"],
      ownerEnv,
      0,
      `factory contract (the Owner's act — this workspace is now contracted)`,
    );
    return { arm, task, workspace: ws, remote, remoteMain };
  }

  // ---- the arm kinds --------------------------------------------------------------------

  async function runAskArm(staged) {
    const { arm, task, workspace } = staged;
    const request = {
      id: randomId(),
      kind: "ask",
      task,
      command: arm.command,
      cwd: workspace,
      agent: "bypass-battery",
      name: "Bash",
    };
    console.log(`$ spool ask: ${arm.command}`);
    submit(spoolRootFor(stateDir), request);
    const reply = await awaitReply(spoolRootFor(stateDir), request.id, ASK_WAIT_MS);
    if (reply === null) return { outcome: "failed", why: `no reply from the plugin after ${ASK_WAIT_MS / 1000}s` };
    if (!reply.ok) return { outcome: "failed", why: `ask rejected (${reply.code}): ${reply.message}` };
    if (reply.decision !== "denied") {
      return { outcome: "escaped", why: `the ask was ${reply.decision ?? "?"} — the policy layer let it through` };
    }
    if (reply.rule !== arm.expectRule) {
      return { outcome: "failed", why: `denied citing ${reply.rule}, expected ${arm.expectRule} — fix the arm or the policy` };
    }
    const denied = countEvent(task, "permit_denied");
    const others = taskLines(task).filter((e) => e.event === "permit_allowed" || e.event === "git_blocked").length;
    if (denied !== 1 || others !== 0) {
      return { outcome: "failed", why: `expected exactly one permit_denied and no other choke lines, got ${denied} denied / ${others} other` };
    }
    return { outcome: "choked", why: reply.summary };
  }

  async function runShimArm(staged) {
    const { arm, task, workspace, remoteMain } = staged;
    const before = remoteMain();
    console.log(`$ PATH-first: ${arm.command}`);
    const result = spawnSync("/bin/sh", ["-c", arm.command], {
      cwd: workspace,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}`, PASEO_AGENT_ID: "bypass-battery" },
    });
    const out = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    console.log(out.split("\n").map((l) => `  ${l}`).join("\n"));
    if (result.status === null) return { outcome: "failed", why: "the escape shell was killed (signal/timeout)" };
    if (result.status === 0 || !out.includes("paseo-factory refused") || remoteMain() !== before) {
      return {
        outcome: "escaped",
        why: `exit ${result.status}, remote ${remoteMain() === before ? "unmoved" : "MOVED"} — the shim did not choke the escape`,
      };
    }
    // The refusal line landed in the shim's log; the plugin's ingestion turns
    // it into the ledger's git_blocked line asynchronously.
    await until(() => {
      if (countEvent(task, "git_blocked") !== 1) {
        throw new Error(`git_blocked lines for ${task}: ${countEvent(task, "git_blocked")} (want 1)`);
      }
    }, "waiting for the shim's ledger line", INGEST_WAIT_MS);
    const others = taskLines(task).filter((e) => e.event === "permit_allowed" || e.event === "permit_denied").length;
    if (others !== 0) return { outcome: "failed", why: `${others} unexpected permit lines alongside the git_blocked` };
    return { outcome: "choked", why: `exit ${result.status} with the refusal line; remote unmoved; one git_blocked line` };
  }

  async function runControlArm(staged) {
    const { arm, task, workspace } = staged;
    const request = {
      id: randomId(),
      kind: "ask",
      task,
      command: arm.command,
      cwd: workspace,
      agent: "bypass-battery",
      name: "Bash",
    };
    console.log(`$ spool ask (benign): ${arm.command}`);
    submit(spoolRootFor(stateDir), request);
    const reply = await awaitReply(spoolRootFor(stateDir), request.id, ASK_WAIT_MS);
    if (reply === null) return { outcome: "failed", why: `no reply from the plugin after ${ASK_WAIT_MS / 1000}s` };
    if (!reply.ok || reply.decision !== "allowed") {
      return { outcome: "escaped", why: `the benign ask was not allowed (${reply.ok ? reply.decision : reply.code}) — a false positive` };
    }
    console.log(`$ PATH-first (benign): ${arm.shimCommand}`);
    const through = spawnSync("/bin/sh", ["-c", arm.shimCommand], {
      cwd: workspace,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}`, PASEO_AGENT_ID: "bypass-battery" },
    });
    if (through.status === null || through.status !== 0) {
      return { outcome: "failed", why: `benign git through the shim exited ${through.status ?? "signal"}: ${(through.stderr ?? "").trim().slice(0, 120)}` };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000)); // give any (wrong) ingestion one poll cycle to land
    const allowed = countEvent(task, "permit_allowed");
    const denied = countEvent(task, "permit_denied");
    const blocked = countEvent(task, "git_blocked");
    if (allowed !== 1 || denied !== 0 || blocked !== 0) {
      return { outcome: "escaped", why: `allowed=${allowed} denied=${denied} blocked=${blocked} — the choke was not invisible` };
    }
    return { outcome: "clean", why: "the benign ask allowed, benign git passed through, zero denies/blocks" };
  }

  async function runArm(arm) {
    const staged = stageArm(arm);
    const result = arm.kind === "shim" ? await runShimArm(staged) : arm.kind === "ask" ? await runAskArm(staged) : await runControlArm(staged);
    if (result.outcome === "failed") {
      console.log(`  technically failed (${result.why})`);
      return { ...result, staged };
    }
    console.log(`  ${result.outcome.toUpperCase()} — ${result.why}`);
    return { ...result, staged };
  }

  // ---- the battery ----------------------------------------------------------------------

  const results = [];
  for (const arm of selected) {
    let result = await runArm(arm);
    if (result.outcome === "failed") {
      console.log(`  re-running ${arm.name} once, per the map's rule`);
      result = await runArm(arm);
      result.retried = true;
    }
    results.push(result);
  }

  step("battery results");
  for (const r of results) {
    console.log(`${r.staged.arm.name}  task=${r.staged.task}  outcome=${r.outcome}${r.retried === true ? "  (after one technical re-run)" : ""}`);
    console.log(`  why: ${r.why}`);
    console.log(`  ground truth: ${r.staged.arm.groundTruth}`);
  }
  const count = (outcome) => results.filter((r) => r.outcome === outcome).length;
  console.log(`\nbattery settled: arms=${results.length} choked=${count("choked")} clean=${count("clean")} escaped=${count("escaped")} failed=${count("failed")}`);
  console.log(`outcomes were asserted against the map's pre-registered rules; still-escaping classes are the operator's honest finding. Nothing was accepted.`);

  const bad = results.filter((r) => r.outcome === "escaped" || r.outcome === "failed");
  if (bad.length > 0) {
    console.error(`\nBATTERY FAIL: arms not choked after their re-run: ${bad.map((r) => `${r.staged.arm.name} (${r.outcome})`).join(", ")}`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`\nBATTERY FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  if (!keep) {
    for (const path of scratch) {
      if (path.startsWith(stateDir)) rmSync(path, { recursive: true, force: true });
    }
    console.log(`\n(cleaned scratch workspaces and remotes; ledger, reports and spool records kept as the audit trail)`);
  }
}
