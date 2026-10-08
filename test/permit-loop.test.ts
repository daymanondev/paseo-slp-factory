import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { disposeDir, makeTempDir, repoRoot } from "./helpers.ts";

/**
 * `scripts/permit-loop.mjs` (retro 2026-10-08, item 3) against a fake `paseo`
 * — a bash script that serves a scripted queue of `permit ls --json` payloads
 * and records every invocation to `calls.log`. The shapes are the real ones
 * from `/tmp/live06-permits.log`: pending entries carry `id`, `agentId`,
 * `agentShortId`, `name`, `description`; allow takes `permit allow <agent>
 * <req_id>`.
 */

const script = join(repoRoot, "scripts", "permit-loop.mjs");

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], extraEnv: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...extraEnv } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const killer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (status) => {
      clearTimeout(killer);
      resolve({ status, stdout, stderr });
    });
  });
}

/** Fake paseo: `permit ls` serves `ls-<n>.json` from the queue dir (exhausted → `[]`); every call is appended to `calls.log`. */
function makeFakePaseo(dir: string): string {
  const bin = join(dir, "fake-paseo");
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env bash",
      'd="$(cd "$(dirname "$0")" && pwd)"',
      'printf "%s\\n" "$*" >> "$d/calls.log"',
      'if [ "$1" = permit ] && [ "$2" = ls ]; then',
      '  n=$(( $(cat "$d/seq" 2>/dev/null || echo 0) + 1 )) && echo "$n" > "$d/seq"',
      '  f="$d/ls-$n.json"',
      '  [ -f "$f" ] && cat "$f" || echo "[]"',
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return bin;
}

function queueLs(dir: string, n: number, payload: string): void {
  writeFileSync(join(dir, `ls-${n}.json`), payload);
}

function calls(dir: string): string[] {
  const log = join(dir, "calls.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").trimEnd().split("\n").filter((l) => l !== "");
}

const agentFull = "b3f14a55-277b-45c4-8f5f-17d978a4be22";
const agentShort = "b3f14a5";
const otherFull = "11111111-2222-3333-4444-555555555555";

/** Every test wants the same scratch dir: fake paseo + a trial home inside it. */
function setup(t: TestContext): { dir: string; paseo: string; home: string } {
  const dir = makeTempDir("permit-loop-test-");
  disposeDir(t, dir);
  const paseo = makeFakePaseo(dir);
  return { dir, paseo, home: join(dir, "trial-home") };
}

function pending(id: string, agentId: string, agentShortId: string, name: string): string {
  return JSON.stringify([{ id, agentId, agentShortId, name, description: "-" }]);
}

test("--once allows every pending request of the agent, one stdout line per grant", async (t) => {
  const { dir, paseo, home } = setup(t);
  queueLs(dir, 1, JSON.stringify([
    { id: "permission-aaa1", agentId: agentFull, agentShortId: agentShort, name: "Edit", description: "-" },
    { id: "permission-aaa2", agentId: agentFull, agentShortId: agentShort, name: "Bash", description: "-" },
  ]));

  const result = await run(["--home", home, "--agent", agentShort, "--once", "--paseo", paseo]);

  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const granted = result.stdout.split("\n").filter((l) => l.includes("ALLOWED"));
  assert.equal(granted.length, 2);
  assert.match(result.stdout, /grants=2/);
  const all = calls(dir);
  assert.equal(all.filter((l) => l.startsWith("permit ls")).length, 1, "one poll under --once");
  for (const id of ["permission-aaa1", "permission-aaa2"]) {
    assert.ok(all.some((l) => l === `permit allow ${agentShort} ${id} --home ${home}`), `missing allow call for ${id}: ${all}`);
  }
});

test("pending requests of other agents are left alone", async (t) => {
  const { dir, paseo, home } = setup(t);
  queueLs(dir, 1, pending("permission-bbb1", otherFull, "1111111", "Edit"));

  const result = await run(["--home", home, "--agent", agentShort, "--once", "--paseo", paseo]);

  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /grants=0/);
  assert.ok(!calls(dir).some((l) => l.startsWith("permit allow")), "no allow call may happen for another agent");
});

test("--agent may be the full agent id", async (t) => {
  const { dir, paseo, home } = setup(t);
  queueLs(dir, 1, pending("permission-ccc1", agentFull, agentShort, "Edit"));

  const result = await run(["--home", home, "--agent", agentFull, "--once", "--paseo", paseo]);

  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /grants=1/);
  assert.ok(calls(dir).some((l) => l === `permit allow ${agentFull} permission-ccc1 --home ${home}`));
});

test("refuses the default home ~/.paseo (prod) before touching paseo", async (t) => {
  const { dir, paseo, home } = setup(t);

  const result = await run(["--home", join(homedir(), ".paseo"), "--agent", agentShort, "--once", "--paseo", paseo]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /prod/i);
  // The guard must fire before the first poll — calls.log does not exist yet.
  assert.ok(!calls(dir).some((l) => l.startsWith("permit ls")), "no poll may reach the default home");
});

test("a malformed poll is survivable: warn, keep polling, grant on the next one", async (t) => {
  const { dir, paseo, home } = setup(t);
  queueLs(dir, 1, "this is not json");
  queueLs(dir, 2, pending("permission-ddd1", agentFull, agentShort, "Edit"));

  const result = await run(["--home", home, "--agent", agentShort, "--max-mins", "0.08", "--interval-ms", "150", "--paseo", paseo]);

  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stderr, /permit ls/);
  assert.match(result.stdout, /grants=1/);
  assert.ok(calls(dir).some((l) => l === `permit allow ${agentShort} permission-ddd1 --home ${home}`));
});

test("--home and --agent are required", async () => {
  const noHome = await run(["--agent", agentShort]);
  assert.equal(noHome.status, 2);
  assert.match(noHome.stderr, /--home/);

  const noAgent = await run(["--home", "/tmp/some-home"]);
  assert.equal(noAgent.status, 2);
  assert.match(noAgent.stderr, /--agent/);
});
