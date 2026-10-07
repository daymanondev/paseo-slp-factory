import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { FactoryError } from "../src/errors.ts";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Predicate for assert.throws / assert.rejects that matches a FactoryError code. */
export function factoryErrorCode(code: string): (err: unknown) => err is FactoryError {
  return (err: unknown): err is FactoryError => err instanceof FactoryError && err.code === code;
}

export function makeTempDir(prefix = "paseo-factory-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function disposeDir(t: TestContext, dir: string): void {
  t.after(() => rmSync(dir, { recursive: true, force: true }));
}

export function copyFixture(name: string, dest: string): void {
  cpSync(join(repoRoot, "fixtures", name), dest, { recursive: true });
}

/**
 * Makes `dir` a git workspace with one commit and returns that commit's full
 * sha — claims are verified against the workspace (ADR 0002), so tests need a
 * real commit to claim, never a fake sha.
 */
export function gitCommitAll(dir: string, message = "test commit"): string {
  const run = (args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
  };
  run(["init", "-q"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Factory Test"]);
  run(["add", "-A"]);
  run(["commit", "-q", "-m", message]);
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
}

/** Commits current changes (the agent's "work") and returns the new full sha. */
export function gitCommitChanges(dir: string, message: string): string {
  const run = (args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
  };
  run(["add", "-A"]);
  run(["commit", "-q", "-m", message]);
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
}
