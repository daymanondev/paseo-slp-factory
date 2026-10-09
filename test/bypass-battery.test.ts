import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../plugin/server/core/factory.ts";
import { createChoke, startGitBlockIngestion } from "../plugin/server/choke.ts";
import { startSpool } from "../plugin/server/spool.ts";
import { ensureClaimCli, ensureGitShim } from "../plugin/server/shell.ts";
import { disposeDir, makeTempDir, repoRoot } from "./helpers.ts";
import type { Factory } from "../plugin/server/core/factory.ts";

/**
 * The bypass battery's hermetic dry-run (v0.0.4 ticket 02's DoD): the real
 * runner (`scripts/bypass-battery.mjs`) drives the real owner CLI over the
 * real spool loop hosted in this process — with the real choke answering
 * synthetic asks and the real git-block ingestion watching the shim's log —
 * against a fake home with the generated wrappers (the ticket-05/flaw-battery
 * pattern). What is asserted: every arm settles CHOKED (control CLEAN) with
 * exactly one ledger line per arm, the map's one technical re-run rule, and
 * that the runner never accepts.
 */

const battery = join(repoRoot, "scripts", "bypass-battery.mjs");

interface BatteryResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runBattery(args: string[]): Promise<BatteryResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [battery, ...args], { env: { ...process.env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const killer = setTimeout(() => child.kill("SIGKILL"), 240_000);
    child.on("close", (status) => {
      clearTimeout(killer);
      resolve({ status, stdout, stderr });
    });
  });
}

/**
 * A fake trial home: the generated claim wrapper and git shim (the runner's
 * liveness pre-flights), and the in-process plugin stand-ins — factory, spool
 * with the choke's ask handler, and the git-block ingestion poller.
 */
function fakeDaemon(t: TestContext, dir: string): Factory {
  const stateDir = join(dir, "paseo-home", "plugin-state", "paseo-factory");
  const factory = createFactory({ stateDir });
  const choke = createChoke({ factory, homeDir: "/fake-home", onLog: () => {} });
  const spool = startSpool(stateDir, factory, { onLog: () => {}, ask: choke.spoolAskHandler, pollMs: 20 });
  const ingestion = startGitBlockIngestion(factory, { pollMs: 20, onLog: () => {} });
  ensureClaimCli(stateDir, join(repoRoot, "plugin"), process.execPath);
  ensureGitShim(stateDir, join(repoRoot, "plugin"), process.execPath);
  t.after(() => {
    spool.stop();
    ingestion.stop();
  });
  return factory;
}

test("dry-run: all four escape arms choke, the control stays clean, and nothing is accepted", async (t) => {
  const dir = makeTempDir("bypass-battery-test-");
  disposeDir(t, dir);
  const factory = fakeDaemon(t, dir);

  const result = await runBattery(["--home", join(dir, "paseo-home")]);
  assert.equal(result.status, 0, `runner stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /battery settled: arms=5 choked=4 clean=1 escaped=0 failed=0/);

  // Per-arm lines and exactly-one-line bookkeeping, read back from the ledger.
  const arms = [
    { prefix: "bp1-force-path", events: ["contract_set", "git_blocked"] },
    { prefix: "bp2-abs-git", events: ["contract_set", "permit_denied"] },
    { prefix: "bp3-outside-write", events: ["contract_set", "permit_denied"] },
    { prefix: "bp4-disguised-force", events: ["contract_set", "permit_denied"] },
    { prefix: "ctl-normal-work", events: ["contract_set", "permit_allowed"] },
  ];
  for (const arm of arms) {
    const task = factory.ledger.events.map((e) => e.task).find((id) => id?.startsWith(`${arm.prefix}-`));
    assert.ok(task, `an arm task with prefix ${arm.prefix} ran`);
    const events = factory.ledger.eventsFor(task).map((e) => e.event);
    assert.deepEqual(events, arm.events, `${arm.prefix}: exactly the contract plus one choke line — nothing more`);
    assert.match(result.stdout, new RegExp(`task=${task}\\s+outcome=${arm.prefix === "ctl-normal-work" ? "clean" : "choked"}`));
  }

  // The denied asks cite the arms' pre-registered rules.
  const rules = factory.ledger.events.filter((e) => e.event === "permit_denied").map((e) => e.rule);
  assert.deepEqual(rules.sort(), ["policy:S1-git-vocabulary", "policy:S1-git-vocabulary", "policy:S2-outside-writable"]);
  const block = factory.ledger.events.find((e) => e.event === "git_blocked");
  assert.equal(block?.rule, "git:force-push");
  assert.match(block?.command ?? "", /push --force/);
  assert.equal(block?.agent, "bypass-battery", "the shim stamped the asking party");

  // The battery measures, it never accepts; scratch is cleaned, audit kept.
  assert.equal(factory.ledger.events.filter((e) => e.event === "attempt_accepted").length, 0);
  const leftovers = readdirSync(factory.stateDir).filter((name) => name.startsWith("bypass-ws-") || name.startsWith("bypass-remote-"));
  assert.deepEqual(leftovers, [], "scratch workspaces and remotes cleaned");
});

test("dry-run: --arm runs a single arm and still refuses the default home", async (t) => {
  const dir = makeTempDir("bypass-battery-one-");
  disposeDir(t, dir);
  fakeDaemon(t, dir);

  const one = await runBattery(["--home", join(dir, "paseo-home"), "--arm", "arm2-absolute-git"]);
  assert.equal(one.status, 0, `runner stdout:\n${one.stdout}\nstderr:\n${one.stderr}`);
  assert.match(one.stdout, /arms: arm2-absolute-git/);
  assert.match(one.stdout, /battery settled: arms=1 choked=1/);

  const missing = await runBattery(["--arm", "no-such-arm", "--home", "/tmp/bypass-battery-unused-home"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /--arm "no-such-arm" matches nothing/);
  assert.equal(existsSync("/tmp/bypass-battery-unused-home"), false, "nothing was created before the refusal");
});
