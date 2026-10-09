import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  agentFate,
  contractFromLedger,
  prepareWorkspace,
  readDriverLedger,
  renderBrief,
  renderRunBanner,
  splitProvider,
  taskOutcome,
} from "../plugin/bin/driver.mjs";
import { copyFixture, disposeDir, gitCommitAll, makeTempDir } from "./helpers.ts";

/**
 * `factory run`'s driver — the pure pieces. The daemon-RPC half (hello,
 * agent.create, snapshot polling) is exercised end to end on the trial home
 * by ticket 04's live runs, not here: a fake daemon would need a WebSocket
 * server, and the zero-dep law keeps one out of the CLIs' world.
 */

test("renderBrief bakes the task and the driver's PATH into the runbook template, verbatim otherwise", () => {
  const brief = renderBrief("live05-driver", "/custom/bin:/usr/bin");

  assert.ok(brief.includes("Do the assigned work on branch `live05-driver`."));
  assert.ok(brief.includes("`factory-claim --task live05-driver --sha <sha>`"));
  assert.ok(brief.includes("If the result is RED: read the note line, fix, make a NEW commit, claim"));
  assert.ok(brief.includes("Never edit tests just to make them green."));
  assert.ok(brief.includes('export\nPATH="/custom/bin:/usr/bin" first.'), "the PATH-export line carries the baked value, not the runbook's hardcoded nvm path");
  assert.ok(!brief.includes("v24.21.0"), "the hardcoded nvm wart is gone");
  assert.ok(!brief.includes("<branch>") && !brief.includes("<task-id>") && !brief.includes("<path>"), "no placeholder survives");
});

test("renderBrief carries the contract's description ahead of the fixed body (the description-slot rider)", () => {
  const withDescription = renderBrief("live06-a", "/custom/bin", "Extract the duplicated ledger read into a shared sibling, plugin/bin/ledger-read.mjs.");
  assert.ok(
    withDescription.startsWith("Task: Extract the duplicated ledger read into a shared sibling, plugin/bin/ledger-read.mjs.\n\n"),
    "the assignment rides first, the fixed body follows unchanged",
  );
  assert.ok(withDescription.includes("Do the assigned work on branch `live06-a`."), "the fixed body is intact below the header");

  // No description: byte-identical to v0.0.5's brief.
  assert.equal(renderBrief("live06-a", "/custom/bin"), renderBrief("live06-a", "/custom/bin", undefined));
});

test("splitProvider takes provider[/model] on the first slash", () => {
  assert.deepEqual(splitProvider("claude"), { provider: "claude", model: undefined });
  assert.deepEqual(splitProvider("claude/opus-4-8"), { provider: "claude", model: "opus-4-8" });
});

test("renderRunBanner echoes the invocation's provider exactly once", () => {
  assert.equal(renderRunBanner(["T1"], "claude"), "factory: run T1 (n=1) — provider claude");
  assert.equal(renderRunBanner(["T1", "T2"], "copilot/gpt-5.4"), "factory: run T1 T2 (n=2) — provider copilot/gpt-5.4");
});

test("readDriverLedger: missing ledger is empty, an unterminated tail is ignored, junk refuses", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const stateDir = join(dir, "state");

  assert.deepEqual(readDriverLedger(stateDir), [], "no ledger yet — the plugin has never run");

  mkdirSync(stateDir, { recursive: true });
  const good = JSON.stringify({ seq: 1, ts: "2026-10-09T09:00:00.000Z", event: "contract_set", task: "T1", workspace: "/w", gate: "true", artifact: "a" });
  writeFileSync(join(stateDir, "ledger.jsonl"), `${good}\n{"seq":2,"ts":"2026-10-09T09`);
  assert.equal(readDriverLedger(stateDir).length, 1, "the unacknowledged tail never happened");

  writeFileSync(join(stateDir, "ledger.jsonl"), `${good}\nnot json\n`);
  assert.throws(() => readDriverLedger(stateDir), /not valid JSON/);
});

test("the driver's ledger views: the contract for pre-spawn, the outcome for the verdict line", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const ts = "2026-10-09T09:00:00.000Z";
  const events = [
    { seq: 1, ts, event: "spawn_dispatched", task: "D1", provider: "claude", arity: 2 },
    { seq: 2, ts, event: "contract_set", task: "D1", workspace: "/ws/one", gate: "npm test", artifact: "src/x.ts", scope: ["src"], description: "Fix the pad helper." },
    { seq: 3, ts, event: "claim_reported", task: "D1", attempt: 1, sha: "a1b2c3d", agent: "ag-1" },
    { seq: 4, ts, event: "gate_finished", task: "D1", attempt: 1, exit: 1, verdict: "red", note: "fail", sha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0" },
    { seq: 5, ts, event: "report_written", task: "D1", attempt: 1, path: "/s/report-D1-1.md" },
    { seq: 6, ts, event: "permit_allowed", task: "D1", agent: "ag-1", name: "Bash", kind: "tool", command: "npm test" },
    { seq: 7, ts, event: "permit_denied", task: "D1", agent: "ag-1", name: "Bash", kind: "tool", command: "git push --force", rule: "policy:S1", reason: "r" },
    { seq: 8, ts, event: "claim_reported", task: "D1", attempt: 2, sha: "f1e2d3c", agent: "ag-1" },
    { seq: 9, ts, event: "gate_finished", task: "D1", attempt: 2, exit: 0, verdict: "green", note: "", sha: "f1e2d3c4b5a6987654321f0e1d2c3b4a5f6e7d8" },
    { seq: 10, ts, event: "report_written", task: "D1", attempt: 2, path: "/s/report-D1-2.md" },
    { seq: 11, ts, event: "git_blocked", task: "D1", command: "git reset --hard", rule: "git:reset-hard", reason: "r", cwd: "/ws/one", blockId: "b1" },
    { seq: 12, ts, event: "spawn_refused", task: "D2", provider: "claude", arity: 2, rule: "spawn:scope-mandatory", reason: "no scope" },
  ];

  const contract = contractFromLedger(events, "D1");
  assert.equal(contract?.workspace, "/ws/one");
  assert.equal(contract?.description, "Fix the pad helper.", "the driver reads the assignment from the contract line (the rider's source)");
  assert.equal(contractFromLedger(events, "NOPE"), undefined);

  const outcome = taskOutcome(events, "D1");
  assert.equal(outcome.attempt, 2, "the last attempt on record");
  assert.equal(outcome.verdict, "green");
  assert.equal(outcome.sha?.slice(0, 7), "f1e2d3c");
  assert.equal(outcome.reportPath, "/s/report-D1-2.md");
  assert.deepEqual([outcome.allowed, outcome.denied, outcome.blocked], [1, 1, 1], "the choke counts the verdict line prints");
  assert.equal(outcome.accepted, false);
});

test("prepareWorkspace: clean tree gets the task's branch, re-run switches to it, dirty or missing refuses", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "ws");
  copyFixture("sample-workspace", workspace);
  gitCommitAll(workspace);

  const first = prepareWorkspace(workspace, "live05-a");
  assert.deepEqual(first, { ok: true, branchExisted: false });
  const again = prepareWorkspace(workspace, "live05-a");
  assert.deepEqual(again, { ok: true, branchExisted: true }, "a re-run switches to the existing branch instead of failing");

  writeFileSync(join(workspace, "src", "format.ts"), "export const dirty = 1;\n");
  const dirty = prepareWorkspace(workspace, "live05-b");
  assert.equal(dirty.ok, false);
  if (!dirty.ok) assert.match(dirty.reason, /tree not clean/);

  const missing = prepareWorkspace(join(dir, "not-there"), "live05-c");
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.reason, /does not exist/);
});

test("agentFate reads a snapshot the way ticket 03 §5 settled it", () => {
  assert.deepEqual(agentFate({ status: "running", pendingPermissions: [] }), { terminal: false });
  assert.deepEqual(agentFate({ status: "initializing" }), { terminal: false });
  assert.deepEqual(agentFate({ status: "idle", attentionReason: "finished", pendingPermissions: [] }), { terminal: true, fate: "finished" });
  assert.deepEqual(
    agentFate({ status: "idle", attentionReason: undefined, lastUserMessageAt: "2026-10-09T09:00:00.000Z", pendingPermissions: [] }),
    { terminal: true, fate: "finished" },
    "idle with the prompt consumed and nothing pending counts as finished even when attention was cleared elsewhere",
  );
  assert.deepEqual(agentFate({ status: "idle", attentionReason: "permission", pendingPermissions: [{ id: "p1" }] }), { terminal: false }, "parked on an ask — the choke answers, the driver waits");
  const died = agentFate({ status: "error", lastError: "provider exploded" });
  assert.equal(died.terminal && died.fate, "died");
  if (died.terminal) assert.match(died.reason ?? "", /provider exploded/);
  const closed = agentFate({ status: "closed" });
  assert.equal(closed.terminal && closed.fate, "closed");
});

test("DaemonRpc routes a response to its waiter by requestId AND response type (the E2E regression)", async () => {
  const { DaemonRpc, DaemonConnectionError } = await import("../plugin/bin/driver.mjs");
  const rpc = new DaemonRpc("/no-home-needed");
  const sent: string[] = [];
  // A fake OPEN socket: connect() is bypassed, only the request/deliver seam runs.
  const asInner = rpc as unknown as { ws: unknown; deliver(msg: unknown): void };
  asInner.ws = { readyState: 1, send: (frame: string) => sent.push(frame) };

  const pending = rpc.request({ type: "probe.request" }, { responseType: "probe.response", timeoutMs: 5_000 });

  // An update-style frame with no requestId of ours, then the wrong type, then
  // the right one — only the last may settle the waiter.
  const requestId = (JSON.parse(sent[0]) as { message: { requestId: string } }).message.requestId;
  asInner.deliver({ type: "probe.update", payload: { idempotencyKey: "k" } });
  asInner.deliver({ type: "other.response", payload: { requestId } });
  asInner.deliver({ type: "probe.response", payload: { requestId, value: 42 } });

  assert.deepEqual(await pending, { requestId, value: 42 });

  // rpc_error rejects with its code attached.
  const failing = rpc.request({ type: "probe.request" }, { responseType: "probe.response", timeoutMs: 5_000 });
  const failingId = (JSON.parse(sent[1]) as { message: { requestId: string } }).message.requestId;
  asInner.deliver({ type: "rpc_error", payload: { requestId: failingId, error: "nope", code: "agent_request_key_conflict" } });
  await assert.rejects(failing, (err: unknown) => err instanceof Error && (err as { code?: string }).code === "agent_request_key_conflict");

  // A socket death rejects whatever is still pending.
  const hanging = rpc.request({ type: "probe.request" }, { responseType: "probe.response", timeoutMs: 60_000 });
  rpc.rejectAllPending(new DaemonConnectionError("test close"));
  await assert.rejects(hanging, DaemonConnectionError);
  rpc.close();
});
