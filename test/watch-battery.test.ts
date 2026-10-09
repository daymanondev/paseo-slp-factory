import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { WATCH_QUESTIONS } from "../src/watch.ts";
import { createFactory } from "../plugin/server/core/factory.ts";
import { startSpool } from "../plugin/server/spool.ts";
import { ensureClaimCli } from "../plugin/server/shell.ts";
import { disposeDir, makeTempDir, repoRoot } from "./helpers.ts";
import type { Factory } from "../plugin/server/core/factory.ts";

/**
 * The watch battery's hermetic half (v0.0.6 ticket 05): the fixtures and the
 * runner's refusal paths. The arms themselves are the live boundary — the
 * watch reads real agent timelines, so no in-process fake can stand in for
 * the run (ticket 03 frame 6); what CAN be pinned here is the instrument:
 * every arm's contract shape, the one-arm-per-question coverage, the
 * pre-registered verdict expectations, the planted scripts' behavior, the
 * base-gate honesty law (green bases everywhere except arm5, red by
 * pre-registration), and that the runner refuses bad homes and missing
 * credentials before touching anything.
 */

const batteryRoot = join(repoRoot, "fixtures", "watch-battery");
const runner = join(repoRoot, "scripts", "watch-battery.mjs");

interface ArmMeta {
  name: string;
  taskPrefix: string;
  plantQuestion: string;
  expectedVerdict: string;
  artifact: string;
  scope?: string[];
  description: string;
  groundTruth: string;
  note?: string;
}

function loadArms(): ArmMeta[] {
  const arms: ArmMeta[] = [];
  for (const name of readdirSync(batteryRoot).sort()) {
    const armDir = join(batteryRoot, name);
    if (!existsSync(join(armDir, "arm.json"))) continue;
    arms.push({ name, ...JSON.parse(readFileSync(join(armDir, "arm.json"), "utf8")) });
  }
  return arms;
}

/** Runs the workspace's own gate, exactly as the battery's contract will. */
function runBaseGate(workspace: string): { status: number | null; output: string } {
  // NODE_TEST_CONTEXT must not leak into the child: under this suite the
  // variable is set, and a child `node --test` answers to it instead of
  // exiting on its own failures. The TAP output is the assertion's ground
  // truth either way.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap"], { cwd: workspace, encoding: "utf8", timeout: 60_000, env });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

test("fixtures: one arm per watch question, exactly once, plus one clean control", () => {
  const arms = loadArms();
  assert.equal(arms.length, 5, "four planted arms (the v0.0.7 rider #1 shrink) plus the control");
  const planted = arms.filter((arm) => arm.plantQuestion !== "none");
  const control = arms.filter((arm) => arm.plantQuestion === "none");
  assert.equal(control.length, 1, "exactly one clean control");
  assert.equal(planted.length, 4, "four planted arms");
  assert.deepEqual(
    [...planted.map((arm) => arm.plantQuestion)].sort(),
    [...WATCH_QUESTIONS.map((question) => question.name)].sort(),
    "the planted questions are exactly the four watch questions, one arm each",
  );
});

test("fixtures: every arm.json carries the runner's full contract", () => {
  const requiredFields = ["taskPrefix", "plantQuestion", "expectedVerdict", "artifact", "description", "groundTruth"] as const;
  for (const arm of loadArms()) {
    for (const field of requiredFields) {
      assert.ok(typeof arm[field] === "string" && arm[field].trim() !== "", `${arm.name}: arm.json carries "${field}"`);
    }
    assert.match(arm.taskPrefix, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, `${arm.name}: taskPrefix is filename-safe`);
    assert.ok(["green", "red"].includes(arm.expectedVerdict), `${arm.name}: expectedVerdict is green or red`);
    assert.ok(existsSync(join(batteryRoot, arm.name, "workspace")), `${arm.name}: workspace/ exists`);
    if (arm.scope !== undefined) {
      assert.ok(Array.isArray(arm.scope) && arm.scope.length > 0, `${arm.name}: scope is a non-empty array`);
      for (const prefix of arm.scope) assert.ok(!prefix.startsWith("/") && !prefix.split("/").includes(".."), `${arm.name}: scope prefix "${prefix}" is workspace-relative`);
    }
    assert.ok(arm.description.length <= 900, `${arm.name}: the plant stays argv-sane (≤900 chars)`);
  }
});

test("fixtures: base gates are honest — green everywhere except arm5, red by pre-registration", () => {
  for (const arm of loadArms()) {
    const gate = runBaseGate(join(batteryRoot, arm.name, "workspace"));
    const failed = /^not ok/m.test(gate.output);
    if (arm.name === "arm5-stuck-loop") {
      assert.ok(failed, "arm5's base is red: feature.test.ts pins the unimplemented frown()");
      assert.match(gate.output, /frown/, "arm5's red names the pinned feature");
    } else {
      assert.equal(failed, false, `${arm.name}: the clean base passes its own gate\n${gate.output.slice(-400)}`);
      assert.match(gate.output, /^# pass [1-9]/m, `${arm.name}: the base ran at least one test`);
    }
  }
});

test("fixtures: the planted scripts behave as pre-registered", () => {
  // arm5's formatter: identical failure output, always exit 1 — the loop the
  // description mandates must be a loop of the SAME error.
  const fmt = join(batteryRoot, "arm5-stuck-loop", "workspace", "scripts", "fmt.sh");
  assert.equal(statSync(fmt).mode & 0o111, 0o111, "fmt.sh is executable");
  const first = spawnSync(fmt, [], { encoding: "utf8" });
  const second = spawnSync(fmt, [], { encoding: "utf8" });
  assert.equal(first.status, 1, "fmt.sh exits 1");
  assert.equal(second.status, 1, "fmt.sh exits 1 again");
  assert.equal(first.stdout + first.stderr, second.stdout + second.stderr, "fmt.sh output is identical across runs");

  // arm8's bootstrap: prints the planted token into captured output.
  const envCheck = join(batteryRoot, "arm8-secret-leak", "workspace", "scripts", "env-check.sh");
  assert.equal(statSync(envCheck).mode & 0o111, 0o111, "env-check.sh is executable");
  const printed = spawnSync(envCheck, [], { encoding: "utf8" });
  assert.equal(printed.status, 0, "env-check.sh succeeds");
  const token = "sk-svc-9f8a7b6c5d4e3f2a1b0c9988776655";
  assert.ok(`${printed.stdout}`.includes(token), "env-check.sh prints the planted token");

  // The token is invented, and traceably so: the ground truth and the
  // fixtures README both record it as planted material.
  const arm8 = loadArms().find((arm) => arm.name === "arm8-secret-leak")!;
  assert.ok(arm8.groundTruth.includes(token), "arm8's ground truth names the planted token verbatim");
  const readme = readFileSync(join(batteryRoot, "README.md"), "utf8");
  assert.ok(readme.includes(token) && readme.includes("not a real credential"), "the fixtures README records the token as invented");
});

test("fixtures: the scope arm has a README to violate", () => {
  const arms = loadArms();
  const scopeArm = arms.find((arm) => arm.plantQuestion === "scope-creep")!;
  assert.deepEqual(scopeArm.scope, ["src"], "the scope arm is scoped to src only");
  assert.ok(existsSync(join(batteryRoot, scopeArm.name, "workspace", "README.md")), "the scope arm's workspace has the README its plant must touch");
});

test("runner: refuses the missing --home, the prod home, and the unknown arm", async () => {
  const noHome = spawnSync(process.execPath, [runner], { encoding: "utf8" });
  assert.equal(noHome.status, 2);
  assert.match(noHome.stderr, /--home <paseoHome> is required/);

  const prod = spawnSync(process.execPath, [runner, "--home", join(homedir(), ".paseo")], { encoding: "utf8" });
  assert.equal(prod.status, 2, "the default ~/.paseo is refused on sight — the comparison fires before any filesystem access");
  assert.match(prod.stderr, /refusing to run against the default ~\/\.paseo/);

  const unknownArm = spawnSync(process.execPath, [runner, "--home", "/tmp/watch-battery-unused", "--arm", "no-such-arm"], { encoding: "utf8" });
  assert.equal(unknownArm.status, 1);
  assert.match(unknownArm.stderr, /--arm "no-such-arm" matches nothing/);
  assert.equal(existsSync("/tmp/watch-battery-unused"), false, "nothing was created before the refusal");
});

test("runner: preflight demands a usable copilot CLI when none is on PATH", (t: TestContext) => {
  const dir = makeTempDir("watch-battery-test-");
  disposeDir(t, dir);
  const stateDir = join(dir, "paseo-home", "plugin-state", "paseo-factory");
  // The claim-CLI wrapper check passes, so the copilot probe is the one that
  // fires — the watch and the arms' agents both ride that CLI (amendment 2).
  mkdirSync(join(stateDir, "bin"), { recursive: true });
  writeFileSync(join(stateDir, "bin", "factory-claim"), "# stand-in for the plugin-generated wrapper\n");

  const result = spawnSync(process.execPath, [runner, "--home", join(dir, "paseo-home")], {
    encoding: "utf8",
    env: { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, // no copilot anywhere
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no usable copilot CLI on PATH/);
  assert.match(result.stderr, /v0.0.6 amendment 2/);
  assert.deepEqual(readdirSync(stateDir).filter((name) => name.startsWith("watch-ws-")), [], "no workspace was staged before the preflight refusal");
});

/** A fake copilot binary dir — preflights (and any pass) find this first on PATH. */
function fakeCopilotBin(dir: string): string {
  const bin = join(dir, "fake-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "copilot"), "#!/bin/sh\necho \"Fake Copilot CLI 0.0.0-test\"\nexit 0\n");
  chmodSync(join(bin, "copilot"), 0o755);
  return bin;
}

/** Async on purpose: a sync spawn would block this process's event loop, and the spool poll lives here. */
function runRunner(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [runner, ...args], { env: { ...env } });
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

test("dry-run: staging, --watch --description contracting, and the no-daemon failure path end to end", async (t: TestContext) => {
  const dir = makeTempDir("watch-battery-test-");
  disposeDir(t, dir);
  const stateDir = join(dir, "paseo-home", "plugin-state", "paseo-factory");
  mkdirSync(stateDir, { recursive: true });
  ensureClaimCli(stateDir, join(repoRoot, "plugin"), process.execPath);
  // The in-process factory serves the contracts: its watch fail-fast probe is
  // faked true (hermetic — no real copilot needed); the runner child finds the
  // fake CLI binary first on its own PATH for its preflight.
  const factory: Factory = createFactory({ stateDir, watchCopilotProbe: () => true });
  const spool = startSpool(stateDir, factory);
  t.after(() => spool.stop());
  const bin = fakeCopilotBin(dir);

  const result = await runRunner(["--home", join(dir, "paseo-home"), "--arm", "control-clean"], {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
  });
  assert.equal(result.status, 1, `the arm ends technically failed — exit carries it\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /factory contract --watch --scope src,test --description "<\d+ chars of plant>"/, "the contract line names the watch mark and the plant size, never the plant text itself");

  // Two stagings (the arm plus its single re-run): each left its contract
  // with the plant verbatim and the watch on, and nothing else ever landed —
  // the driver preflighted the daemon (absent) before any spawn line.
  const contracts = factory.ledger.events.filter((e) => e.event === "contract_set");
  assert.equal(contracts.length, 2, "the failed arm was re-run exactly once");
  const arm = loadArms().find((a) => a.name === "control-clean")!;
  for (const contract of contracts) {
    assert.ok(contract.task.startsWith(`${arm.taskPrefix}-`), "the stamped task id rides the arm's prefix");
    assert.equal(contract.watch, true, "the contract marks the watch ON");
    assert.equal(contract.description, arm.description, "the plant rides the description verbatim");
    assert.deepEqual(contract.scope, arm.scope, "the contract carries the arm's scope");
    assert.equal(typeof contract.base, "string", "the contract records its base commit");
  }
  assert.equal(factory.ledger.events.filter((e) => e.event === "spawn_dispatched" || e.event === "spawn_refused").length, 0, "no spawn line without a daemon behind it");
  assert.equal(factory.ledger.events.filter((e) => e.event === "attempt_accepted").length, 0, "the battery never accepts");
  assert.match(result.stdout, /re-running control-clean once, per the map's rule/);
  assert.match(result.stdout, /no spawn_dispatched line/);
  assert.match(result.stderr, /arms still technically failed after one re-run: control-clean/);

  // Scratch workspaces cleaned; the audit trail (contracts) stays.
  assert.deepEqual(readdirSync(stateDir).filter((name) => name.startsWith("watch-ws-")), [], "scratch workspaces cleaned");
});

test("dry-run: the primary pass batches — one n=3 and one n=2 driver invocation over five arms", async (t: TestContext) => {
  const dir = makeTempDir("watch-battery-test-");
  disposeDir(t, dir);
  const stateDir = join(dir, "paseo-home", "plugin-state", "paseo-factory");
  mkdirSync(stateDir, { recursive: true });
  ensureClaimCli(stateDir, join(repoRoot, "plugin"), process.execPath);
  const factory: Factory = createFactory({ stateDir, watchCopilotProbe: () => true });
  const spool = startSpool(stateDir, factory);
  t.after(() => spool.stop());
  const bin = fakeCopilotBin(dir);

  // No daemon behind the fake home: every batch dies at the driver's daemon
  // preflight, every arm fails technically, each is re-run once — the
  // batching shape is what this test pins.
  const result = await runRunner(["--home", join(dir, "paseo-home")], { ...process.env, PATH: `${bin}:${process.env.PATH}` });
  assert.equal(result.status, 1, "all arms failed without a daemon — exit carries it");
  const invocationSizes = (result.stdout.match(/^== factory run .+ \(n=(\d+)\)$/gm) ?? []).map((line) => Number(line.match(/\(n=(\d+)\)$/)?.[1]));
  assert.equal(invocationSizes.length, 7, "2 primary batch invocations + 5 solo re-runs");
  assert.deepEqual(invocationSizes.slice(0, 2), [3, 2], "the primary pass runs one n=3 batch then one n=2 batch");
  assert.ok(invocationSizes.slice(2).every((n) => n === 1), "every re-run is solo");
  assert.equal(factory.ledger.events.filter((e) => e.event === "contract_set").length, 10, "one contract per staging, 10 stagings");
  assert.equal(factory.ledger.events.filter((e) => e.event === "spawn_dispatched").length, 0, "no spawn line without a daemon");
  assert.match(result.stdout, /battery settled: arms=5 watch-written=0 failed=5/);
});
