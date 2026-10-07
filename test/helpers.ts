import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { FactoryError } from "../src/errors.ts";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Gates run with this process's environment — the plugin's under the daemon,
 * this suite's here — and fixture contracts gate on `npm test`. A suite started
 * by absolute node path (exactly what the factory's own gate does) can carry a
 * PATH without npm on it, so resolve npm from beside the running node before
 * any gate inherits this env. No assertion depends on it; without it the
 * fixture gates die at `npm: command not found` instead of running.
 */
process.env.PATH = `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`;

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

/** One request the fake eye received — body already parsed when JSON. */
export interface FakeEyeRequest {
  path: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}

export type FakeEyeResponse = { status: number; payload: unknown } | { hang: true };

export interface FakeEye {
  url: string;
  requests: FakeEyeRequest[];
  /** Closes the listener so the port refuses connections — a dead daemon. */
  stop(): Promise<void>;
}

/**
 * A local stand-in for the eye's Anthropic-messages API: hermetic, loopback
 * only, no network. `respond` is called per request so a test can change its
 * answer mid-pass (retry rules); `{ hang: true }` never answers, for budget
 * tests. Every request is recorded for prompt-content assertions.
 */
export async function startFakeEye(t: TestContext, respond: () => FakeEyeResponse): Promise<FakeEye> {
  const requests: FakeEyeRequest[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        // kept raw — non-JSON bodies are a legitimate failure case
      }
      requests.push({ path: req.url ?? "/", headers: req.headers, body });
      const answer = respond();
      if ("hang" in answer) return;
      res.statusCode = answer.status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(answer.payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const stop = (): Promise<void> =>
    new Promise<void>((resolve) => server.close(() => resolve()));
  t.after(() => stop());
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake eye did not get a port");
  return { url: `http://127.0.0.1:${address.port}`, requests, stop };
}

/** Writes the eye's config (ticket 04 shape) pointing at the fake server. */
export function writeEyeConfig(stateDir: string, baseUrl: string, model = "fake-eye-1"): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "eye.json"), `${JSON.stringify({ provider: "fake", model, apiKey: "test-key", baseUrl }, null, 2)}\n`);
}

/** The standard Anthropic-messages text answer. */
export function eyeAnswer(text: string): unknown {
  return { content: [{ type: "text", text }] };
}
