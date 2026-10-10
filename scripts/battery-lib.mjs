import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Same shape as src/factory.ts TASK_ID_PATTERN — task ids become filenames. */
export const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const step = (name) => console.log(`\n== ${name}`);

export const die = (message) => {
  throw new Error(message);
};

export const stamp = () => `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;

export function flag(argv, name) {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

export function parseBatteryArgs(scriptName, argv = process.argv.slice(2)) {
  const homeFlag = flag(argv, "--home");
  const armFlag = flag(argv, "--arm");
  const keep = argv.includes("--keep");
  if (homeFlag === undefined || homeFlag === "") {
    console.error(`${scriptName}: --home <paseoHome> is required (point it at the trial daemon, never ~/.paseo)`);
    process.exit(2);
  }
  const home = homeFlag.startsWith("~") ? join(homedir(), homeFlag.slice(2)) : homeFlag;
  if (home === join(homedir(), ".paseo")) {
    console.error(`${scriptName}: refusing to run against the default ~/.paseo — that is prod; use the trial home (~/.paseo-factory)`);
    process.exit(2);
  }
  return { argv, armFlag, keep, home, stateDir: join(home, "plugin-state", "paseo-factory") };
}

export function createScratchRegistry(stateDir) {
  const paths = new Set();
  return {
    add(path) {
      paths.add(path);
      return path;
    },
    cleanup() {
      for (const path of paths) {
        if (path.startsWith(stateDir)) rmSync(path, { recursive: true, force: true });
      }
    },
  };
}

export function run(command, args, env, expectStatus, label) {
  const result = spawnSync(command, args, { encoding: "utf8", env, timeout: 10 * 60_000 });
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  console.log(`$ ${label}\n${out.split("\n").map((line) => `  ${line}`).join("\n")}`);
  if (result.status !== expectStatus) {
    die(`${label}: expected exit ${expectStatus}, got ${result.status === null ? "signal/killed" : result.status}`);
  }
  return out;
}

export function ledgerLines(stateDir, { allowMissing = false } = {}) {
  const path = join(stateDir, "ledger.jsonl");
  if (allowMissing && !existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trimEnd()
    .split("\n")
    .filter((line) => !(allowMissing && line === ""))
    .map((line) => JSON.parse(line));
}

export function taskLines(stateDir, task, options) {
  return ledgerLines(stateDir, options).filter((event) => event.task === task);
}
