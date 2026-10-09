import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../plugin/server/core/factory.ts";
import { handleSpoolRequest, parseSpoolRequest, spoolRootFor, startSpool } from "../plugin/server/spool.ts";
import { disposeDir, gitCommitAll, makeTempDir } from "./helpers.ts";

const POLL_MS = 20;

/** The CLI half's write pattern: tmp file + rename, so the plugin never reads a half-written request. */
function dropRequest(spoolRoot: string, body: Record<string, unknown> & { id: string }): void {
  const requestsDir = join(spoolRoot, "requests");
  mkdirSync(requestsDir, { recursive: true });
  const path = join(requestsDir, `${body.id}.json`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(body)}\n`);
  renameSync(tmp, path);
}

function readReply(spoolRoot: string, id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(spoolRoot, "replies", `${id}.json`), "utf8")) as Record<string, unknown>;
}

/** Waits (bounded) until the condition holds — spool answers are asynchronous by design. */
async function until(assertion: () => void, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      assertion();
      return;
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }
}

test("parseSpoolRequest accepts exactly the three request shapes and nothing else", () => {
  assert.deepEqual(parseSpoolRequest({ id: "r1", kind: "claim", task: "T1", sha: "abc" }), {
    id: "r1",
    kind: "claim",
    task: "T1",
    sha: "abc",
  });
  assert.deepEqual(parseSpoolRequest({ id: "r1", kind: "accept", task: "T1", attempt: 2 }), {
    id: "r1",
    kind: "accept",
    task: "T1",
    attempt: 2,
  });
  assert.deepEqual(parseSpoolRequest({ id: "r1", kind: "contract", task: "T1", workspace: "/w", gate: "true", artifact: "a" }), {
    id: "r1",
    kind: "contract",
    task: "T1",
    workspace: "/w",
    gate: "true",
    artifact: "a",
  });
  assert.deepEqual(
    parseSpoolRequest({ id: "r1", kind: "contract", task: "T1", workspace: "/w", gate: "true", artifact: "a", freshEyes: true }),
    { id: "r1", kind: "contract", task: "T1", workspace: "/w", gate: "true", artifact: "a", freshEyes: true },
    "freshEyes passes only as literal true",
  );

  for (const bad of [
    null,
    "claim",
    {},
    { id: "r1" },
    { id: "r1", kind: "teleport" },
    { id: "r1", kind: "claim" },
    { id: "r1", kind: "claim", task: "T1", sha: 7 },
    { id: "r1", kind: "accept", task: "T1", attempt: "2" },
    { kind: "claim", task: "T1", sha: "abc" },
    { id: "r1", kind: "contract", task: "T1", workspace: "/w", gate: "true", artifact: "a", freshEyes: "yes" },
    { id: "r1", kind: "contract", task: "T1", workspace: "/w", gate: "true", artifact: "a", freshEyes: false },
  ]) {
    assert.equal(parseSpoolRequest(bad), undefined, `${JSON.stringify(bad)} must be rejected`);
  }
});

test("handleSpoolRequest turns factory errors into rejected replies, never throws", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const factory = createFactory({ stateDir: join(dir, "state") });

  const rejected = await handleSpoolRequest(factory, { id: "r1", kind: "claim", task: "T404", sha: "abc" });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.code, "unknown-task");
});

test("the spool loop answers requests, moves them to processed, and keeps the reply", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const factory = createFactory({ stateDir });
  const spool = startSpool(stateDir, factory, { pollMs: POLL_MS });
  t.after(() => spool.stop());

  const spoolRoot = spoolRootFor(stateDir);
  dropRequest(spoolRoot, { id: "req-1", kind: "contract", task: "T1", workspace: "/definitely/missing", gate: "true", artifact: "a" });

  await until(() => {
    assert.ok(existsSync(join(spoolRoot, "replies", "req-1.json")), "the reply landed");
  });
  const reply = readReply(spoolRoot, "req-1");
  assert.equal(reply.ok, false);
  assert.equal(reply.code, "invalid-contract");
  assert.ok(!existsSync(join(spoolRoot, "requests", "req-1.json")), "the request left the queue");
  assert.ok(existsSync(join(spoolRoot, "processed", "req-1.json")), "the request is kept in processed/");
});

test("a malformed request file gets a bad-request reply instead of being dropped silently", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "state");
  const factory = createFactory({ stateDir });
  const spool = startSpool(stateDir, factory, { pollMs: POLL_MS });
  t.after(() => spool.stop());

  const spoolRoot = spoolRootFor(stateDir);
  dropRequest(spoolRoot, { id: "req-2", kind: "nonsense" });

  await until(() => {
    assert.equal(readReply(spoolRoot, "req-2").code, "bad-request");
  });
});

test("a replayed request with an existing reply runs nothing a second time (ADR 0004)", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "ws");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "format.ts"), "export const x = 1;\n");
  gitCommitAll(workspace);

  const stateDir = join(dir, "state");
  const factory = createFactory({ stateDir });
  const spool = startSpool(stateDir, factory, { pollMs: POLL_MS });
  t.after(() => spool.stop());

  const spoolRoot = spoolRootFor(stateDir);
  const body = { id: "req-3", kind: "contract", task: "T1", workspace, gate: "true", artifact: "src/format.ts" };
  dropRequest(spoolRoot, body);
  await until(() => {
    assert.equal(readReply(spoolRoot, "req-3").ok, true);
  });
  assert.equal(factory.ledger.events.length, 1);

  // The CLI retried with the same id after already getting its reply.
  dropRequest(spoolRoot, body);
  await until(() => {
    assert.ok(!existsSync(join(spoolRoot, "requests", "req-3.json")), "the replay moved through");
  });
  assert.equal(factory.ledger.events.length, 1, "no second contract event — no second anything");
});

test("parseSpoolRequest accepts the synthetic-ask shape and nothing around it", () => {
  assert.deepEqual(parseSpoolRequest({ id: "r1", kind: "ask", task: "T1", command: "git push --force" }), {
    id: "r1",
    kind: "ask",
    task: "T1",
    command: "git push --force",
  });
  assert.deepEqual(
    parseSpoolRequest({ id: "r1", kind: "ask", task: "T1", command: "x", cwd: "/w", agent: "battery", name: "Bash" }),
    { id: "r1", kind: "ask", task: "T1", command: "x", cwd: "/w", agent: "battery", name: "Bash" },
  );
  for (const bad of [
    { id: "r1", kind: "ask", task: "T1" },
    { id: "r1", kind: "ask", task: "T1", command: "  " },
    { id: "r1", kind: "ask", task: "T1", command: "x", cwd: 7 },
    { id: "r1", kind: "ask", task: "T1", command: "x", agent: true },
  ]) {
    assert.equal(parseSpoolRequest(bad), undefined, `${JSON.stringify(bad)} must be rejected`);
  }
});

test("handleSpoolRequest routes asks to the choke handler and refuses loudly without one", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const factory = createFactory({ stateDir: join(dir, "state") });

  const refused = await handleSpoolRequest(factory, { id: "r1", kind: "ask", task: "T1", command: "x" });
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.code, "ask-unavailable");
    assert.match(refused.message, /synthetic asks/);
  }

  const answered = await handleSpoolRequest(factory, { id: "r2", kind: "ask", task: "T1", command: "x" }, (req) => ({
    id: req.id,
    ok: true,
    summary: "ask denied (test)",
    decision: "denied",
    rule: "policy:S1-git-vocabulary",
  }));
  assert.deepEqual(answered, {
    id: "r2",
    ok: true,
    summary: "ask denied (test)",
    decision: "denied",
    rule: "policy:S1-git-vocabulary",
  });
});
