import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFactory } from "../src/factory.ts";
import { buildCodeAnswers, renderTimelineTranscript, runWatchPass, WATCH_QUESTIONS } from "../src/watch.ts";
import { WATCH_CHARS_PER_TOKEN, WATCH_PROMPT_TOKEN_GUARD, WATCH_TIMELINE_MAX_CHARS } from "../src/constants.ts";
import type { Factory } from "../src/factory.ts";
import type { ContractSet, WatchWritten } from "../src/events.ts";
import type { WatchTimelineEntry } from "../src/watch.ts";
import {
  disposeDir,
  factoryErrorCode,
  fetchViaFake,
  gitCommitAll,
  gitCommitChanges,
  jevAnswer,
  makeTempDir,
  startFakeEye,
  writeWatchConfig,
} from "./helpers.ts";

/**
 * The watch station (v0.0.6, tickets 01–04) against a fake Decisions API on
 * loopback — hermetic, no network (the pinned OpenRouter URL is rerouted to
 * the fake). Every behavior the design fixed: trigger (BOTH verdicts, marked
 * contracts only), the state's composition and caps, the free-tier code
 * answers, the one ledger line, report rendering, failure semantics (no
 * agent, no timeline, missing answers, retry rules, budget), and the
 * description-slot rider's contract field.
 */

/** All eight names, one happy answer set — sorted desc: fake-done, scope-creep, … */
const ALL_EIGHT: Record<string, number> = {
  "destructive-writes": 0.12,
  "test-weakened": 0.05,
  "fake-done": 0.83,
  "unverified-claims": 0.4,
  "stuck-loop": 0.2,
  "scope-creep": 0.61,
  "self-accept": 0.02,
  "secret-leak": 0.07,
};

/** A three-entry projected timeline — the shapes the transcript renderer must speak. */
const TIMELINE: WatchTimelineEntry[] = [
  { seq: 2, item: { type: "user_message", text: "Do the assigned work on branch `w1`." } },
  { seq: 5, item: { type: "tool_call", name: "Bash", status: "completed", detail: { type: "shell", command: "npm test", exitCode: 0, output: "ok 3 tests" } } },
  { seq: 7, item: { type: "assistant_message", text: "Done — all tests pass." } },
];

const timelineFetcher = (entries: WatchTimelineEntry[]) => {
  const seen: string[] = [];
  return {
    seen,
    fetch: async (agentId: string) => {
      seen.push(agentId);
      return { ok: true as const, entries };
    },
  };
};

/** A git workspace at its base commit, ready for a Contract. */
function makeWorkspaceAtBase(dir: string): { workspace: string; artifact: string; base: string } {
  const workspace = join(dir, "ws");
  mkdirSync(join(workspace, "src"), { recursive: true });
  const artifact = "src/format.ts";
  writeFileSync(join(workspace, artifact), "export function pad() {}\n");
  const base = gitCommitAll(workspace);
  return { workspace, artifact, base };
}

/** The Agent's "work": a real change, committed — returns the claimable sha. */
function commitFix(workspace: string, artifact: string): string {
  writeFileSync(join(workspace, artifact), "export function pad(input: string): string {\n  return input;\n}\n");
  return gitCommitChanges(workspace, "implement pad");
}

function watchEvent(factory: Factory, task: string): WatchWritten {
  const watch = factory.ledger.eventsFor(task).findLast((e): e is WatchWritten => e.event === "watch_written");
  assert.ok(watch, "watch_written landed");
  return watch;
}

/** The request body the fake Decisions API received (the latest one), parsed. */
function requestBody(fake: { requests: { body: unknown }[] }): Record<string, unknown> {
  const body = fake.requests.at(-1)?.body;
  assert.ok(typeof body === "object" && body !== null, "the fake API received a JSON body");
  return body as Record<string, unknown>;
}

function stateOf(fake: { requests: { body: unknown }[] }): Record<string, unknown> {
  return requestBody(fake).state as Record<string, unknown>;
}

test("fail-fast at contract_set: watch without watch.json is refused, loudly, before any work", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const factory = createFactory({ stateDir: join(dir, "factory") });

  assert.throws(
    () => factory.setContract({ task: "W1", workspace, gate: "true", artifact, watch: true }),
    (err: unknown) => err instanceof Error && /watch\.json/.test(err.message) && factoryErrorCode("watch-unconfigured")(err),
  );
  assert.deepEqual([...factory.ledger.events], [], "a refused contract writes nothing");
});

test("fail-fast at contract_set: watch.json without an apiKey is refused", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "watch.json"), JSON.stringify({}));
  const factory = createFactory({ stateDir });

  assert.throws(
    () => factory.setContract({ task: "W2", workspace, gate: "true", artifact, watch: true }),
    factoryErrorCode("watch-unconfigured"),
  );
});

test("watch: false is refused — the mark is ON or absent, never off-by-accident", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const factory = createFactory({ stateDir: join(dir, "factory") });

  assert.throws(
    () => factory.setContract({ task: "W3", workspace, gate: "true", artifact, watch: false as unknown as true }),
    factoryErrorCode("invalid-contract"),
  );
});

test("a green marked claim runs the watch: ledger order, event fields, request shape, report line", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  const fake = await startFakeEye(t, () => ({ status: 200, payload: jevAnswer(ALL_EIGHT, { cost: 0.00063 }) }));
  writeWatchConfig(stateDir);
  const feed = timelineFetcher(TIMELINE);

  const factory = createFactory({ stateDir, fetchTimeline: feed.fetch, watchFetchImpl: fetchViaFake(fake) });
  factory.setContract({ task: "W4", workspace, gate: "echo gate-ran", artifact, watch: true, description: "Implement pad()." });
  const claimed = commitFix(workspace, artifact);
  const outcome = await factory.claim({ task: "W4", sha: claimed, agent: "agent-w4" });
  assert.equal(outcome.verdict, "green");

  // Ticket 03's closing-window order: the watch sits between the verdict and
  // the report, where the eye would — on both verdicts, here green.
  assert.deepEqual(factory.ledger.eventsFor("W4").map((e) => e.event), [
    "contract_set",
    "claim_reported",
    "gate_started",
    "gate_finished",
    "watch_written",
    "report_written",
  ]);

  // The timeline read targeted the claiming agent.
  assert.deepEqual(feed.seen, ["agent-w4"]);

  const watch = watchEvent(factory, "W4");
  assert.equal(watch.model, "typesafe/jev-1.13-20260917", "the dated snapshot is recorded verbatim");
  assert.equal(watch.outcome, "written");
  assert.deepEqual(watch.answers, ALL_EIGHT);
  assert.deepEqual(watch.usage, { input_tokens: 476, cost: 0.00063 }, "usage.cost is the response's own — grade A by construction");
  assert.ok(typeof watch.durationMs === "number" && watch.durationMs >= 0);
  assert.equal(watch.error, undefined);

  // The one POST: pinned URL, bearer key, pinned model, session id, all 8
  // noul questions, and the state in the eye's order.
  assert.equal(fake.requests.length, 1);
  const request = fake.requests[0]!;
  assert.equal(request.path, "/api/alpha/decisions");
  assert.equal(request.headers.authorization, "Bearer test-watch-key");
  const body = requestBody(fake);
  assert.equal(body.model, "typesafe/jev-1.13");
  assert.equal(body.session_id, "W4/1");
  const questions = body.questions as Record<string, { type: string; instructions: string; criteria: { true: string; false: string } }>;
  assert.deepEqual(Object.keys(questions), WATCH_QUESTIONS.map((q) => q.name), "all 8 questions, ticket 03's order");
  for (const question of WATCH_QUESTIONS) {
    assert.equal(questions[question.name]!.type, "noul");
    assert.equal(questions[question.name]!.instructions, question.instructions, `${question.name}: literal wording`);
    assert.equal(questions[question.name]!.criteria.true, question.criteria.true);
    assert.equal(questions[question.name]!.criteria.false, question.criteria.false);
  }
  assert.ok(!("prior" in body) && !JSON.stringify(body).includes('"prior"'), "priors are never sent — the API has no prior field");

  const state = stateOf(fake);
  assert.deepEqual(Object.keys(state), ["note", "contract", "diff", "gate_output", "code_answers", "timeline"]);
  const stateContract = state.contract as Record<string, unknown>;
  assert.equal(stateContract.task, "W4");
  assert.equal(stateContract.description, "Implement pad().");
  assert.equal(stateContract.verdict, "green");
  assert.equal(stateContract.claimed_sha, claimed);
  assert.ok(String(state.diff).includes("+export function pad(input: string)"), "the diff is in the state");
  assert.equal(state.gate_output, "gate-ran\n");
  assert.ok(String(state.timeline).includes("[2] user_message: Do the assigned work on branch `w1`."));
  assert.ok(String(state.timeline).includes("[5] tool_call/shell: npm test [exit 0] out: ok 3 tests"));
  assert.ok(String(state.timeline).includes("[7] assistant_message: Done — all tests pass."));
  const codeAnswers = state.code_answers as Record<string, unknown>;
  assert.match(String(codeAnswers.artifact_check), /present/);
  assert.match(String(codeAnswers.scope_check), /unrestricted/);
  assert.deepEqual(codeAnswers.git_blocks, []);
  assert.equal(codeAnswers.self_accept, "impossible by construction — acceptance is Owner-only (ADR 0005)");
  assert.ok(!JSON.stringify(body).includes("test-watch-key"), "the key never leaks into the request body");

  // The report carries the watch's line between the Verdict and the closing
  // language, answers sorted desc, with the display-only ≥0.5 callout.
  const report = readFileSync(outcome.reportPath, "utf8");
  const verdictAt = report.indexOf("- Verdict: GREEN");
  const watchAt = report.indexOf("- Watch (jev-1.13-20260917) — 8 answers: fake-done 0.83, scope-creep 0.61");
  const closingAt = report.indexOf("- Evidence, not acceptance");
  assert.ok(verdictAt > -1 && watchAt > verdictAt && closingAt > watchAt, "watch line sits between verdict and closing language");
  assert.ok(report.includes("≥0.5: fake-done, scope-creep"), "the callout names the flagged questions, display-only");
});

test("a red verdict runs the watch too — with honest markers where the stations never reached", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  const fake = await startFakeEye(t, () => ({ status: 200, payload: jevAnswer(ALL_EIGHT) }));
  writeWatchConfig(stateDir);
  const feed = timelineFetcher(TIMELINE);

  const factory = createFactory({ stateDir, fetchTimeline: feed.fetch, watchFetchImpl: fetchViaFake(fake) });
  factory.setContract({ task: "W5", workspace, gate: "exit 1", artifact, watch: true });
  const claimed = commitFix(workspace, artifact);
  const outcome = await factory.claim({ task: "W5", sha: claimed, agent: "agent-w5" });
  assert.equal(outcome.verdict, "red");

  assert.equal(watchEvent(factory, "W5").outcome, "written", "red is watched — the battery's red arms depend on it");
  const state = stateOf(fake);
  assert.equal((state.contract as Record<string, unknown>).verdict, "red");
  const codeAnswers = state.code_answers as Record<string, unknown>;
  assert.match(String(codeAnswers.artifact_check), /present/, "the gate ran and the artifact existed — the fact, not the verdict");

  // A station-1 red (no resolved sha) never resolved a diff — the state says
  // so instead of leaving a silent gap.
  const factory2 = createFactory({
    stateDir: join(dir, "factory2"),
    fetchTimeline: feed.fetch,
    watchFetchImpl: fetchViaFake(fake),
  });
  writeWatchConfig(join(dir, "factory2"));
  factory2.setContract({ task: "W5b", workspace, gate: "true", artifact, watch: true });
  await factory2.claim({ task: "W5b", sha: "deadbeef", agent: "agent-w5b" });

  const station1State = stateOf(fake);
  assert.equal(station1State.diff, "[diff unavailable: no resolved sha]");
  const station1Answers = station1State.code_answers as Record<string, unknown>;
  assert.match(String(station1Answers.artifact_check), /not checked/);
  assert.equal(station1State.gate_output, "[gate did not run this attempt]");
  assert.ok(factory2.ledger.eventsFor("W5b").some((e) => e.event === "watch_written"), "the pass still ran and recorded");
});

test("a scope red carries its violations into the free tier", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const workspace = join(dir, "ws");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src/keep.ts"), "export const a = 1;\n");
  gitCommitAll(workspace);
  const stateDir = join(dir, "factory");
  const fake = await startFakeEye(t, () => ({ status: 200, payload: jevAnswer(ALL_EIGHT) }));
  writeWatchConfig(stateDir);
  const factory = createFactory({ stateDir, fetchTimeline: timelineFetcher(TIMELINE).fetch, watchFetchImpl: fetchViaFake(fake) });

  factory.setContract({ task: "W6", workspace, gate: "true", artifact: "src/keep.ts", scope: ["src/inside"], watch: true });
  mkdirSync(join(workspace, "src/inside"), { recursive: true });
  writeFileSync(join(workspace, "src/inside/x.ts"), "export const x = 1;\n");
  writeFileSync(join(workspace, "src/outside.ts"), "export const oops = 1;\n");
  const claimed = gitCommitChanges(workspace, "scope creep");
  await factory.claim({ task: "W6", sha: claimed, agent: "agent-w6" });

  const codeAnswers = stateOf(fake).code_answers as Record<string, unknown>;
  assert.equal(codeAnswers.scope_check, "violations: src/outside.ts");
});

test("git blocks the ledger holds ride the free tier", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  const fake = await startFakeEye(t, () => ({ status: 200, payload: jevAnswer(ALL_EIGHT) }));
  writeWatchConfig(stateDir);
  const factory = createFactory({ stateDir, fetchTimeline: timelineFetcher(TIMELINE).fetch, watchFetchImpl: fetchViaFake(fake) });

  factory.setContract({ task: "W7", workspace, gate: "true", artifact, watch: true });
  factory.ledger.append({ event: "git_blocked", task: "W7", agent: "agent-w7", command: "git push --force origin main", rule: "git:force-push", reason: "destructive", cwd: workspace, blockId: "b-1" });
  const claimed = commitFix(workspace, artifact);
  await factory.claim({ task: "W7", sha: claimed, agent: "agent-w7" });

  const codeAnswers = stateOf(fake).code_answers as Record<string, unknown>;
  assert.deepEqual(codeAnswers.git_blocks, ["git:force-push: git push --force origin main"]);
});

test("an unmarked contract behaves exactly like before — no watch.json needed, no watch call, no line", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const factory = createFactory({ stateDir: join(dir, "factory") }); // no watch.json anywhere

  factory.setContract({ task: "W8", workspace, gate: "true", artifact });
  const claimed = commitFix(workspace, artifact);
  const outcome = await factory.claim({ task: "W8", sha: claimed, agent: "agent-w8" });

  assert.equal(outcome.verdict, "green");
  assert.ok(!factory.ledger.eventsFor("W8").some((e) => e.event === "watch_written"));
  const report = readFileSync(outcome.reportPath, "utf8");
  assert.ok(!report.includes("Watch"), "no watch line where none was asked for");
});

test("a claim with no agent is an honest failed line — no call, no timeline to read", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  const fake = await startFakeEye(t, () => ({ status: 200, payload: jevAnswer(ALL_EIGHT) }));
  writeWatchConfig(stateDir);
  const factory = createFactory({ stateDir, fetchTimeline: timelineFetcher(TIMELINE).fetch, watchFetchImpl: fetchViaFake(fake) });

  factory.setContract({ task: "W9", workspace, gate: "true", artifact, watch: true });
  const claimed = commitFix(workspace, artifact);
  const outcome = await factory.claim({ task: "W9", sha: claimed });

  assert.equal(outcome.verdict, "green", "a failed watch never touches the verdict");
  assert.equal(fake.requests.length, 0, "no timeline means no ask — the questions are about the run");
  const watch = watchEvent(factory, "W9");
  assert.equal(watch.outcome, "failed");
  assert.match(watch.error!, /no agent bound to the claim/);
  assert.equal(watch.model, "typesafe/jev-1.13", "the pinned request model stands in when no response arrived");
  const report = readFileSync(outcome.reportPath, "utf8");
  assert.ok(report.includes("- Watch — FAILED: "), "the failure renders where the Owner reads");
  const accepted = factory.accept({ task: "W9", attempt: 1 });
  assert.equal(accepted.event, "attempt_accepted", "accept still requires only a green verdict");
});

test("a timeline the daemon cannot serve is a failed line naming the reason", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  const fake = await startFakeEye(t, () => ({ status: 200, payload: jevAnswer(ALL_EIGHT) }));
  writeWatchConfig(stateDir);
  const factory = createFactory({
    stateDir,
    fetchTimeline: async () => ({ ok: false, reason: "the daemon answered: Unknown agent" }),
    watchFetchImpl: fetchViaFake(fake),
  });

  factory.setContract({ task: "W10", workspace, gate: "true", artifact, watch: true });
  const claimed = commitFix(workspace, artifact);
  await factory.claim({ task: "W10", sha: claimed, agent: "agent-restarted-away" });

  const watch = watchEvent(factory, "W10");
  assert.equal(watch.outcome, "failed");
  assert.match(watch.error!, /Unknown agent/);
});

test("a shell with no captured PaseoApi is a failed line — the plugin was never hooked", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  const fake = await startFakeEye(t, () => ({ status: 200, payload: jevAnswer(ALL_EIGHT) }));
  writeWatchConfig(stateDir);
  const factory = createFactory({ stateDir, watchFetchImpl: fetchViaFake(fake) }); // no fetchTimeline

  factory.setContract({ task: "W11", workspace, gate: "true", artifact, watch: true });
  const claimed = commitFix(workspace, artifact);
  await factory.claim({ task: "W11", sha: claimed, agent: "agent-w11" });

  const watch = watchEvent(factory, "W11");
  assert.equal(watch.outcome, "failed");
  assert.match(watch.error!, /no PaseoApi/);
});

test("a response missing question names: nulls recorded, outcome failed naming the missing", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  // Two of the eight answered, and one of those carries a non-numeric noul.
  const payload = {
    model: "typesafe/jev-1.13-20260917",
    answers: { "fake-done": { type: "noul", noul: 0.9 }, "secret-leak": { type: "noul", noul: "high" } },
    usage: { input_tokens: 400, cost: 0.0000168 },
  };
  const fake = await startFakeEye(t, () => ({ status: 200, payload }));
  writeWatchConfig(stateDir);
  const factory = createFactory({ stateDir, fetchTimeline: timelineFetcher(TIMELINE).fetch, watchFetchImpl: fetchViaFake(fake) });

  factory.setContract({ task: "W12", workspace, gate: "true", artifact, watch: true });
  const claimed = commitFix(workspace, artifact);
  const outcome = await factory.claim({ task: "W12", sha: claimed, agent: "agent-w12" });

  const watch = watchEvent(factory, "W12");
  assert.equal(watch.outcome, "failed");
  assert.equal(watch.answers!["fake-done"], 0.9, "the one good answer is kept");
  assert.equal(watch.answers!["secret-leak"], null, "a non-numeric noul is a null, never a guess");
  assert.match(watch.error!, /missing question answers: destructive-writes/);
  assert.match(watch.error!, /secret-leak/);
  assert.deepEqual(watch.usage, { input_tokens: 400, cost: 0.0000168 }, "the usage of the response that did arrive is kept");
  const report = readFileSync(outcome.reportPath, "utf8");
  assert.ok(report.includes("- Watch — FAILED: missing question answers"), "the report keys on the outcome, not the partial answers");
});

test("a 429 with Retry-After: 0 then a 200 — exactly one retry, honoring the header", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  let calls = 0;
  const fake = await startFakeEye(t, () => {
    calls += 1;
    return calls === 1
      ? { status: 429, payload: { error: { message: "rate limited", code: "rate_limit_exceeded" } }, headers: { "retry-after": "0" } }
      : { status: 200, payload: jevAnswer(ALL_EIGHT) };
  });
  writeWatchConfig(stateDir);
  const factory = createFactory({ stateDir, fetchTimeline: timelineFetcher(TIMELINE).fetch, watchFetchImpl: fetchViaFake(fake) });

  factory.setContract({ task: "W13", workspace, gate: "true", artifact, watch: true });
  const claimed = commitFix(workspace, artifact);
  await factory.claim({ task: "W13", sha: claimed, agent: "agent-w13" });

  assert.equal(fake.requests.length, 2, "one transient retry, immediately (Retry-After: 0)");
  assert.equal(watchEvent(factory, "W13").outcome, "written");
});

test("a 500 then a 200 retries on the exponential backoff and succeeds", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  let calls = 0;
  const fake = await startFakeEye(t, () => {
    calls += 1;
    return calls === 1 ? { status: 500, payload: { error: { message: "server", code: "server" } } } : { status: 200, payload: jevAnswer(ALL_EIGHT) };
  });
  writeWatchConfig(stateDir);
  const factory = createFactory({
    stateDir,
    fetchTimeline: timelineFetcher(TIMELINE).fetch,
    watchFetchImpl: fetchViaFake(fake),
    watchBudgetMs: 5_000,
  });

  factory.setContract({ task: "W14", workspace, gate: "true", artifact, watch: true });
  const claimed = commitFix(workspace, artifact);
  await factory.claim({ task: "W14", sha: claimed, agent: "agent-w14" });

  assert.equal(fake.requests.length, 2);
  assert.equal(watchEvent(factory, "W14").outcome, "written");
});

test("a 401 is never retried: one call, a visible failed line", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  const fake = await startFakeEye(t, () => ({ status: 401, payload: { error: { message: "No cookie auth credentials found", code: 401 } } }));
  writeWatchConfig(stateDir);
  const factory = createFactory({ stateDir, fetchTimeline: timelineFetcher(TIMELINE).fetch, watchFetchImpl: fetchViaFake(fake) });

  factory.setContract({ task: "W15", workspace, gate: "true", artifact, watch: true });
  const claimed = commitFix(workspace, artifact);
  await factory.claim({ task: "W15", sha: claimed, agent: "agent-w15" });

  assert.equal(fake.requests.length, 1, "auth failures get no retry storm");
  const watch = watchEvent(factory, "W15");
  assert.equal(watch.outcome, "failed");
  assert.match(watch.error!, /401/);
  assert.match(watch.error!, /No cookie auth credentials found/);
});

test("a 400 context_length_exceeded is never retried — the pre-send estimate is the guard, not a retrim loop", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  const fake = await startFakeEye(t, () => ({ status: 400, payload: { error: { message: "state exceeds the 32000 token limit", code: "context_length_exceeded" } } }));
  writeWatchConfig(stateDir);
  const factory = createFactory({ stateDir, fetchTimeline: timelineFetcher(TIMELINE).fetch, watchFetchImpl: fetchViaFake(fake) });

  factory.setContract({ task: "W16", workspace, gate: "true", artifact, watch: true });
  const claimed = commitFix(workspace, artifact);
  await factory.claim({ task: "W16", sha: claimed, agent: "agent-w16" });

  assert.equal(fake.requests.length, 1);
  assert.match(watchEvent(factory, "W16").error!, /400/);
});

test("the budget covers every try: a hanging endpoint is cut off and recorded", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  const fake = await startFakeEye(t, () => ({ hang: true }));
  writeWatchConfig(stateDir);
  const factory = createFactory({
    stateDir,
    fetchTimeline: timelineFetcher(TIMELINE).fetch,
    watchFetchImpl: fetchViaFake(fake),
    watchBudgetMs: 300,
  });

  factory.setContract({ task: "W17", workspace, gate: "true", artifact, watch: true });
  const claimed = commitFix(workspace, artifact);
  const started = Date.now();
  const outcome = await factory.claim({ task: "W17", sha: claimed, agent: "agent-w17" });
  const wall = Date.now() - started;

  assert.ok(wall < 10_000, `the pass stayed near its budget (took ${wall}ms)`);
  assert.equal(outcome.verdict, "green");
  const watch = watchEvent(factory, "W17");
  assert.equal(watch.outcome, "failed");
  assert.match(watch.error!, /budget of 300ms exceeded/);
  assert.ok(watch.durationMs >= 250, `durationMs tells the truth (${watch.durationMs}ms)`);
});

test("usage.cost absent falls back to input_tokens × $0.042/MTok", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  const fake = await startFakeEye(t, () => ({
    status: 200,
    payload: { ...(jevAnswer(ALL_EIGHT) as Record<string, unknown>), usage: { input_tokens: 10_000, output_tokens: 8 } },
  }));
  writeWatchConfig(stateDir);
  const factory = createFactory({ stateDir, fetchTimeline: timelineFetcher(TIMELINE).fetch, watchFetchImpl: fetchViaFake(fake) });

  factory.setContract({ task: "W18", workspace, gate: "true", artifact, watch: true });
  const claimed = commitFix(workspace, artifact);
  await factory.claim({ task: "W18", sha: claimed, agent: "agent-w18" });

  const usage = watchEvent(factory, "W18").usage!;
  assert.equal(usage.input_tokens, 10_000);
  assert.ok(Math.abs(usage.cost - 0.00042) < 1e-12, `10k tokens at $0.042/MTok = $0.00042, got ${usage.cost}`);
});

test("the transcript renderer: one line per entry, outputs kept, failures named", () => {
  const entries: WatchTimelineEntry[] = [
    ...TIMELINE,
    { seq: 9, item: { type: "tool_call", name: "Bash", status: "failed", detail: { type: "shell", command: "npm test", exitCode: 1, output: "AssertionError: expected 2\ngot 3" } } },
    { seq: 11, item: { type: "tool_call", name: "Edit", status: "completed", detail: { type: "edit", filePath: "test/x.test.ts", unifiedDiff: "-assert.equal(n, 2)\n+assert.equal(n, 3)" } } },
    { seq: 13, item: { type: "todo", items: [{ text: "write tests", completed: true }, { text: "fix bug", completed: false }] } },
    { seq: 15, item: { type: "error", message: "provider exploded" } },
    { seq: 17, item: { type: "notification", level: "warning", message: "context low" } },
    { seq: 19, item: { type: "compaction", status: "completed", trigger: "auto" } },
    { seq: 21, item: { type: "plugin", pluginId: "other", kind: "note", data: { hello: 1 } } },
    { seq: 23, item: { type: "tool_call", name: "WebFetch", status: "completed", detail: { type: "fetch", url: "https://x.test", code: 200, result: "ok" } } },
    { seq: 25, item: { type: "mystery_item", text: "from the future" } },
  ];
  const transcript = renderTimelineTranscript(entries);
  const lines = transcript.split("\n");
  assert.equal(lines.length, entries.length, "exactly one line per entry");
  assert.equal(lines[0], "[2] user_message: Do the assigned work on branch `w1`.");
  assert.equal(lines[3], "[9] tool_call/shell: npm test [exit 1] out: AssertionError: expected 2\\ngot 3 ! failed: ");
  assert.equal(lines[4], "[11] tool_call/edit: test/x.test.ts diff: -assert.equal(n, 2)\\n+assert.equal(n, 3)");
  assert.match(lines[5]!, /^\[13\] todo: 1\/2 done: \[x\] write tests; \[ \] fix bug$/);
  assert.equal(lines[6], "[15] error: provider exploded");
  assert.equal(lines[7], "[17] notification(warning): context low");
  assert.equal(lines[8], "[19] compaction: completed (auto)");
  assert.match(lines[9]!, /^\[21\] plugin\(other\/note\): /);
  assert.equal(lines[10], "[23] tool_call/fetch: https://x.test [200] ok");
  assert.match(lines[11]!, /^\[25\] mystery_item: /);
});

test("an oversized timeline is tail-capped with its marker; the newest entries survive", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  const fake = await startFakeEye(t, () => ({ status: 200, payload: jevAnswer(ALL_EIGHT) }));
  writeWatchConfig(stateDir);

  // One giant shell output past the timeline cap — the marker must show and
  // the tail survive, the head go.
  const overCap: WatchTimelineEntry[] = [
    { seq: 1, item: { type: "user_message", text: "start of the run" } },
    { seq: 3, item: { type: "tool_call", name: "Bash", status: "completed", detail: { type: "shell", command: "spew", exitCode: 0, output: "x".repeat(200_000) } } },
  ];
  const factory = createFactory({ stateDir, fetchTimeline: timelineFetcher(overCap).fetch, watchFetchImpl: fetchViaFake(fake) });
  factory.setContract({ task: "W19", workspace, gate: "true", artifact, watch: true });
  const claimed = commitFix(workspace, artifact);
  await factory.claim({ task: "W19", sha: claimed, agent: "agent-w19" });

  const state = stateOf(fake);
  const timeline = String(state.timeline);
  assert.ok(timeline.startsWith("[truncated]"), "the cut timeline says so");
  assert.ok(timeline.length < WATCH_TIMELINE_MAX_CHARS + 1_000, `capped near ${WATCH_TIMELINE_MAX_CHARS}, got ${timeline.length}`);
  assert.ok(!timeline.includes("start of the run"), "the tail is kept, the head is cut");
  assert.ok(/x{1000}/.test(timeline), "the newest entry's output tail survives");
  assert.ok(JSON.stringify(state).length <= WATCH_PROMPT_TOKEN_GUARD * WATCH_CHARS_PER_TOKEN, "the whole state stays under the token guard");
});

test("the ÷3 token guard trims the timeline below its own cap when the rest of the state is fat too", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, base } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  const fake = await startFakeEye(t, () => ({ status: 200, payload: jevAnswer(ALL_EIGHT) }));
  writeWatchConfig(stateDir);

  // Diff near its 16k cap, gate output near its 8k cap, timeline at its 64k
  // cap: together over the 90k-char guard, so the timeline must shrink past
  // its own cap to fit — the only 32k-prompt-token guard (ticket 03 §3).
  writeFileSync(join(workspace, artifact), `export const big = "${"y".repeat(20_000)}";\n`);
  const fatSha = gitCommitChanges(workspace, "fat change");
  const gateLog = join(stateDir, "gate-fat.log");
  writeFileSync(gateLog, `z`.repeat(9_000));
  const fatTimeline: WatchTimelineEntry[] = Array.from({ length: 200 }, (_, i) => ({
    seq: i + 1,
    item: { type: "assistant_message", text: `entry-${i} ${"w".repeat(500)}` },
  }));
  // A destructive-writes arm's shape: many blocked git attempts, each riding
  // the free tier — the extra ~3k chars push the state past the guard.
  const manyBlocks = Array.from({ length: 60 }, (_, i) => ({ rule: "git:force-push", command: `git push --force origin backup-${i}` }));
  const contract: ContractSet = {
    seq: 1,
    ts: "2026-10-09T09:00:00.000Z",
    event: "contract_set",
    task: "W20",
    workspace,
    gate: "true",
    artifact,
    base,
    watch: true,
  };

  const rawTranscript = renderTimelineTranscript(fatTimeline);
  assert.ok(rawTranscript.length > WATCH_TIMELINE_MAX_CHARS, "the fixture actually overflows the cap");
  const outcome = await runWatchPass({
    stateDir,
    contract,
    task: "W20",
    attempt: 1,
    verdict: "green",
    sha: fatSha,
    gateResult: { exit: 0, verdict: "green", note: "", timedOut: false, output: "z", artifactPresent: true },
    gateOutputPath: gateLog,
    scopeViolations: [],
    agent: "agent-w20",
    fetchTimeline: timelineFetcher(fatTimeline).fetch,
    gitBlocks: manyBlocks,
    fetchImpl: fetchViaFake(fake),
    budgetMs: 5_000,
  });

  assert.equal(outcome.outcome, "written");
  const state = stateOf(fake);
  const timeline = String(state.timeline);
  assert.ok(timeline.startsWith("[truncated]"), "trimmed, still marked");
  assert.ok(timeline.includes("entry-199"), "the newest entries survive the further trim");
  assert.ok(timeline.length < WATCH_TIMELINE_MAX_CHARS - 1_000, `the guard pushed the timeline below its own cap (got ${timeline.length})`);
  assert.ok(JSON.stringify(state).length <= WATCH_PROMPT_TOKEN_GUARD * WATCH_CHARS_PER_TOKEN, `the guard holds (state ${JSON.stringify(state).length} chars)`);
});

test("buildCodeAnswers: every branch of the free tier", () => {
  const base = { verdict: "green" as const, artifact: "out.txt", gitBlocks: [] as { rule: string; command: string }[] };
  assert.equal(
    buildCodeAnswers({ ...base, gateRan: true, artifactPresent: true, scope: undefined, scopeViolations: undefined }).artifact_check,
    'present (the gate checked "out.txt")',
  );
  assert.equal(
    buildCodeAnswers({ ...base, gateRan: true, artifactPresent: false, scope: undefined, scopeViolations: undefined }).artifact_check,
    'missing (the gate checked "out.txt")',
  );
  assert.equal(
    buildCodeAnswers({ ...base, gateRan: false, artifactPresent: undefined, scope: undefined, scopeViolations: undefined }).artifact_check,
    "not checked (the gate did not run — the verdict landed before the gate station)",
  );
  assert.equal(
    buildCodeAnswers({ ...base, gateRan: true, artifactPresent: undefined, scope: undefined, scopeViolations: undefined }).scope_check,
    "unrestricted (the Contract declared no scope)",
  );
  assert.equal(
    buildCodeAnswers({ ...base, gateRan: true, artifactPresent: true, scope: ["src"], scopeViolations: [] }).scope_check,
    "clean (no changes outside [src])",
  );
  assert.equal(
    buildCodeAnswers({ ...base, gateRan: true, artifactPresent: true, scope: ["src"], scopeViolations: ["a.ts", "b.ts"] }).scope_check,
    "violations: a.ts, b.ts",
  );
  assert.equal(
    buildCodeAnswers({ ...base, gateRan: true, artifactPresent: true, scope: ["src"], scopeViolations: undefined }).scope_check,
    "not checked (the scope station produced no measurement this attempt)",
  );
  assert.deepEqual(
    buildCodeAnswers({ ...base, gateRan: true, artifactPresent: true, scope: ["src"], scopeViolations: [], gitBlocks: [{ rule: "git:reset-hard", command: "git reset --hard" }] }).git_blocks,
    ["git:reset-hard: git reset --hard"],
  );
});

test("the description-slot rider: the Contract records the assignment, the gate's artifact fact rides GateResult", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  const fake = await startFakeEye(t, () => ({ status: 200, payload: jevAnswer(ALL_EIGHT) }));
  writeWatchConfig(stateDir);
  const factory = createFactory({ stateDir, fetchTimeline: timelineFetcher(TIMELINE).fetch, watchFetchImpl: fetchViaFake(fake) });

  const contract = factory.setContract({
    task: "W21",
    workspace,
    gate: "true",
    artifact,
    watch: true,
    description: "Add the pad() helper with its tests.",
  });
  assert.equal(contract.description, "Add the pad() helper with its tests.", "the assignment is Contract data now");
  const claimed = commitFix(workspace, artifact);
  const outcome = await factory.claim({ task: "W21", sha: claimed, agent: "agent-w21" });

  assert.equal((stateOf(fake).contract as Record<string, unknown>).description, "Add the pad() helper with its tests.", "the watch's state carries the intent");
  assert.ok(existsSync(outcome.reportPath));
});

test("R1 symmetry: a restart during the watch's window writes the missing report — never a second gate_finished, never a re-run", (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  writeWatchConfig(stateDir);

  // The factory "crashes" after a green verdict landed but before the watch
  // or the report finished — the exact window the watch opened.
  const crashed = createFactory({ stateDir });
  crashed.setContract({ task: "W22", workspace, gate: "true", artifact, watch: true });
  const claimed = commitFix(workspace, artifact);
  crashed.ledger.append({ event: "claim_reported", task: "W22", attempt: 1, sha: claimed, agent: "agent-w22" });
  crashed.ledger.append({ event: "gate_started", task: "W22", attempt: 1, cmd: "true" });
  crashed.ledger.append({ event: "gate_finished", task: "W22", attempt: 1, exit: 0, verdict: "green", note: "", sha: claimed });

  const reopened = createFactory({ stateDir });

  assert.deepEqual(reopened.recoveredAttempts, [{ task: "W22", attempt: 1 }]);
  const finished = reopened.ledger.eventsFor("W22").filter((e) => e.event === "gate_finished");
  assert.equal(finished.length, 1, "the verdict that already landed is never overwritten");
  const reportPath = join(stateDir, "report-W22-1.md");
  assert.ok(existsSync(reportPath), "the missing report is written on recovery");
  const report = readFileSync(reportPath, "utf8");
  assert.ok(report.includes("- Verdict: GREEN"));
  assert.ok(!report.includes("Watch"), "an interrupted pass leaves no watch line — it is never re-run");
});

test("runWatchPass direct: the pinned model, the literal questions, and the state — the API's own shape", async (t) => {
  const dir = makeTempDir();
  disposeDir(t, dir);
  const { workspace, artifact, base } = makeWorkspaceAtBase(dir);
  const stateDir = join(dir, "factory");
  const fake = await startFakeEye(t, () => ({ status: 200, payload: jevAnswer(ALL_EIGHT) }));
  writeWatchConfig(stateDir);
  const contract: ContractSet = {
    seq: 1,
    ts: "2026-10-09T09:00:00.000Z",
    event: "contract_set",
    task: "W23",
    workspace,
    gate: "npm test",
    artifact,
    scope: ["src"],
    base,
    watch: true,
  };

  const outcome = await runWatchPass({
    stateDir,
    contract,
    task: "W23",
    attempt: 2,
    verdict: "green",
    sha: base,
    gateResult: { exit: 0, verdict: "green", note: "", timedOut: false, output: "", artifactPresent: true },
    gateOutputPath: undefined,
    scopeViolations: [],
    agent: "agent-w23",
    fetchTimeline: timelineFetcher(TIMELINE).fetch,
    gitBlocks: [],
    fetchImpl: fetchViaFake(fake),
    budgetMs: 5_000,
  });

  assert.equal(outcome.outcome, "written");
  assert.equal(outcome.model, "typesafe/jev-1.13-20260917");
  assert.equal(fake.requests.length, 1);
  assert.equal(requestBody(fake).session_id, "W23/2", "session_id is the task/attempt pair — observability only");
});
