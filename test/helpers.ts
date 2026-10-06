import { cpSync, mkdtempSync, rmSync } from "node:fs";
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
