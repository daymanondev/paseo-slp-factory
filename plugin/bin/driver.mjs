#!/usr/bin/env node
/**
 * The driver behind `factory run` (v0.0.5 ticket 04) — spawn, refuse, guard.
 *
 * Laws it lives under:
 *
 * - **One writer (ADR 0004):** the driver never writes the ledger. It submits
 *   a `spawn` request per task through the spool and reads the plugin's
 *   reply; verdicts are read back from the ledger the plugin maintains (the
 *   same read-only read `factory status` does).
 * - **Zero runtime deps:** node's built-in `WebSocket` + `node:fs` +
 *   `node:child_process`, nothing else. The daemon WS protocol is
 *   source-verified against `@getpaseo/client` 0.10.3 (v0.0.5 ticket 01's
 *   scout): hello with the local credential, then JSON RPC in
 *   `{type:"session", message:{…}}` envelopes, responses matched by
 *   requestId. `paseo.pid` and `local-credential` are re-read on every
 *   connect — both are rewritten on daemon restart.
 * - **No respawn, ever:** a dead agent is reported (exit 2); retry policy
 *   belongs to a later row. A driver crash is safe to re-run: the spool
 *   dedupes replayed request files and the create RPC is idempotency-keyed
 *   by task id, so a re-run meets either the existing agent or a structured
 *   conflict — never a second agent.
 *
 * Plain .mjs like its siblings: the daemon's node may lack TypeScript
 * stripping, and CLIs import no plugin server code (ADR 0004).
 */
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readLedgerEvents } from "./ledger-read.mjs";
import { awaitReply, randomId, submit } from "./spool-client.mjs";

/** Snapshot polling cadence — the observe loop's only clock (ticket 03 §5). */
export const POLL_MS = 5_000;
/** Spawns stagger a few seconds apart — CPU etiquette, not correctness (ticket 03 §7). */
export const STAGGER_MS = 3_000;
/** Stall is report-only: status `running` with no timeline growth (or an ask parked this long) warns once. */
export const STALL_WARN_MS = 10 * 60_000;
/** A fetch that answers `agent: null` for this long after create is a death — 0.11 answers unready agents with null, not an error. */
export const AGENT_MISSING_DEAD_MS = 2 * 60_000;
/** Creating an agent runs the before-hooks and boots a provider session — this is not a fast RPC. */
const CREATE_TIMEOUT_MS = 120_000;
const CONNECT_TIMEOUT_MS = 10_000;

// Mirrors TASK_ID_PATTERN in src/factory.ts — the CLIs import no src/ code
// (ADR 0004); the driver checks it before the id becomes a git branch name.
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// The runbook's fixed brief (docs/runbooks/live-run.md step 5) — only the
// placeholders and the baked PATH vary, never the words. Since v0.0.6 a
// contract's description rides ahead of the fixed body (the description-slot
// rider): the assignment reaches the agent in the brief itself, retiring the
// v0.0.5 TASK.md seed workaround. No description, no header — the brief is
// byte-identical to v0.0.5's.
const BRIEF_TEMPLATE = `Do the assigned work on branch \`<branch>\`. When done: commit, run
\`git rev-parse HEAD\`, then \`factory-claim --task <task-id> --sha <sha>\`.
If the result is RED: read the note line, fix, make a NEW commit, claim
again with the new sha. Never edit tests just to make them green.

Your shells under the daemon start without git/node/npm on PATH — export
PATH="<path>" first.`;

/**
 * The brief, rendered per task — `<branch>` and `<task-id>` are the task id; the
 * PATH is baked from the driver's own environment at spawn time; the
 * contract's description (when set) rides ahead as the assignment header.
 */
export function renderBrief(task, pathValue, description) {
  const body = BRIEF_TEMPLATE.replaceAll("<branch>", task)
    .replaceAll("<task-id>", task)
    .replace('PATH="<path>" first.', `PATH="${pathValue}" first.`);
  if (description === undefined || description === null) return body;
  return `Task: ${description}\n\n${body}`;
}

/** `--provider claude/opus-4-8` → provider `claude`, model `opus-4-8`; a bare id carries no model. */
export function splitProvider(value) {
  const slash = value.indexOf("/");
  return slash === -1 ? { provider: value, model: undefined } : { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

// ---- the ledger, read locally (the plugin is the only writer — never this file) -----------------

/**
 * Reads the ledger's complete lines — through the shared reader
 * (ledger-read.mjs) under the driver's own policy: the plugin is the only
 * writer (ADR 0004) and validated each line when it appended it, so blank
 * lines are skipped and only unparseable JSON refuses. A missing ledger is
 * an empty one (the plugin has never run); anything else unreadable throws —
 * the driver refuses to guess.
 */
export function readDriverLedger(stateDir) {
  const ledgerPath = join(stateDir, "ledger.jsonl");
  const read = readLedgerEvents(ledgerPath);
  if (read.missing) return [];
  if (read.failed !== undefined) throw read.failed;
  if (read.corrupt !== undefined) throw new Error(`${ledgerPath} is not a readable ledger: ${read.corrupt}`);
  return read.events;
}

/** The task's Contract — the driver's pre-spawn source for the workspace. */
export function contractFromLedger(events, task) {
  let contract;
  for (const evt of events) {
    if (evt.event === "contract_set" && evt.task === task) contract = evt;
  }
  return contract;
}

/**
 * What the driver reports at a task's verdict: the last Attempt's number,
 * verdict and attested sha, the report path, the choke counts, acceptance.
 * All from the ledger the plugin wrote while the agent worked.
 */
export function taskOutcome(events, task) {
  const outcome = { attempt: 0, verdict: undefined, sha: undefined, reportPath: undefined, allowed: 0, denied: 0, blocked: 0, accepted: false };
  for (const evt of events) {
    if (evt.task !== task) continue;
    if (evt.event === "gate_finished") {
      outcome.attempt = evt.attempt;
      outcome.verdict = evt.verdict;
      outcome.sha = typeof evt.sha === "string" ? evt.sha : undefined;
    } else if (evt.event === "report_written") {
      outcome.reportPath = evt.path;
    } else if (evt.event === "permit_allowed") {
      outcome.allowed += 1;
    } else if (evt.event === "permit_denied") {
      outcome.denied += 1;
    } else if (evt.event === "git_blocked") {
      outcome.blocked += 1;
    } else if (evt.event === "attempt_accepted") {
      outcome.accepted = true;
    }
  }
  return outcome;
}

// ---- pre-spawn: local sanity + the branch (ticket 03 §2 — refusals here write no ledger line) ----

function gitIn(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8", timeout: 15_000 });
}

/**
 * The two local sanity checks plus the branch: the workspace must exist and
 * sit clean (`git status --porcelain` empty), then the driver switches to
 * the task's branch — creating it on first run, switching when it already
 * exists (the re-run case). The agent never creates branches; task ids are
 * branch-safe by the same pattern the core enforces.
 */
export function prepareWorkspace(workspace, task) {
  let info;
  try {
    info = statSync(workspace);
  } catch {
    return { ok: false, reason: `workspace "${workspace}" does not exist` };
  }
  if (!info.isDirectory()) {
    return { ok: false, reason: `workspace "${workspace}" is not a directory` };
  }
  const status = gitIn(workspace, ["status", "--porcelain"]);
  if (status.error !== undefined || status.status !== 0) {
    return { ok: false, reason: `git cannot read ${workspace}: ${firstLine(status.stderr ?? status.error?.message ?? "")}` };
  }
  const changes = status.stdout.split("\n").filter((line) => line.trim() !== "");
  if (changes.length > 0) {
    return { ok: false, reason: `workspace tree not clean (${changes.length} change${changes.length === 1 ? "" : "s"}): ${changes[0].trim()}` };
  }
  const branchExists = gitIn(workspace, ["show-ref", "--verify", "--quiet", `refs/heads/${task}`]).status === 0;
  const switched = branchExists ? gitIn(workspace, ["switch", task]) : gitIn(workspace, ["switch", "-c", task]);
  if (switched.error !== undefined || switched.status !== 0) {
    return { ok: false, reason: `could not ${branchExists ? "switch to" : "create"} branch ${task}: ${firstLine(switched.stderr ?? switched.error?.message ?? "")}` };
  }
  return { ok: true, branchExisted: branchExists };
}

function firstLine(text) {
  return typeof text === "string" && text.trim() !== "" ? text.trim().split("\n")[0] : "unknown git failure";
}

// ---- the daemon, over its own WebSocket (scout §a: hello + localCredential + session envelopes) ----

/**
 * Parses one WS text frame into its session message: `{type:"session",
 * message:{…}}` unwraps to the message; top-level frames (`hello.rejected`)
 * pass through with their envelope type attached. Undefined when the frame is
 * not JSON — the daemon never sends that, and ignoring beats crashing.
 */
function unwrap(event) {
  const text = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8");
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (envelope.type === "session") return envelope.message;
  return { ...envelope, envelopeType: envelope.type };
}

/**
 * A minimal daemon RPC client: connect (re-reading `paseo.pid` and the
 * credential each time), hello, then fire requests matched by requestId.
 * `features` carries what `server_info` advertised — the modern
 * `agent.create.request` rides on `creationLifecycle`, the legacy
 * `create_agent_request` otherwise.
 */
export class DaemonRpc {
  /** @param {string} home the paseo home carrying `paseo.pid` + `local-credential` */
  constructor(home) {
    this.home = home;
    this.ws = null;
    this.features = null;
    this.waiters = new Map();
    this.requestCounter = 0;
  }

  /** Connects and completes the hello handshake. Throws on failure — callers decide what a failed daemon means. */
  connect(timeoutMs = CONNECT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      let listen;
      try {
        listen = JSON.parse(readFileSync(join(this.home, "paseo.pid"), "utf8")).listen;
      } catch (err) {
        reject(new Error(`cannot read the daemon address from ${join(this.home, "paseo.pid")}: ${err.message}`));
        return;
      }
      if (typeof listen !== "string" || listen === "") {
        reject(new Error(`${join(this.home, "paseo.pid")} carries no listen address`));
        return;
      }
      let token;
      try {
        token = readFileSync(join(this.home, "local-credential"), "utf8").trim();
      } catch (err) {
        reject(new Error(`cannot read ${join(this.home, "local-credential")}: ${err.message}`));
        return;
      }
      let ws;
      try {
        ws = new WebSocket(`ws://${listen}/ws`);
      } catch (err) {
        reject(new Error(`cannot open ws://${listen}/ws: ${err.message}`));
        return;
      }
      this.ws = ws;
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("message", onHandshakeMessage);
        ws.removeEventListener("close", onClose);
        ws.removeEventListener("error", onError);
        if (err !== undefined) {
          try {
            ws.close();
          } catch {}
          reject(err);
        } else {
          // Past the handshake, inbound frames route to request waiters and
          // a socket death rejects them — reconnection is the poll loop's
          // business, not the socket's.
          ws.addEventListener("message", (event) => {
            const msg = unwrap(event);
            if (msg !== undefined) this.deliver(msg);
          });
          ws.addEventListener("close", () => this.rejectAllPending(new DaemonConnectionError("the daemon socket closed")));
          resolve();
        }
      };
      const timer = setTimeout(() => finish(new Error(`daemon handshake timed out after ${timeoutMs}ms (ws://${listen}/ws)`)), timeoutMs);
      const onOpen = () => {
        ws.send(
          JSON.stringify({
            type: "hello",
            clientId: `paseo-factory-driver-${randomUUID().slice(0, 8)}`,
            clientType: "cli",
            protocolVersion: 1,
            auth: { kind: "localCredential", token },
          }),
        );
      };
      const onHandshakeMessage = (event) => {
        const msg = unwrap(event);
        if (msg === undefined) return;
        if (msg.envelopeType === "hello.rejected") {
          finish(new Error(`daemon rejected the hello: ${JSON.stringify(msg.reason ?? "")}`));
          return;
        }
        if (msg.type === "status" && msg.payload?.status === "server_info") {
          this.features = msg.payload.features ?? {};
          finish();
          return;
        }
      };      const onClose = () => finish(new Error("the daemon socket closed before the handshake finished"));
      const onError = () => finish(new Error(`the daemon socket errored before the handshake finished (ws://${listen}/ws)`));
      ws.addEventListener("open", onOpen);
      ws.addEventListener("message", onHandshakeMessage);
      ws.addEventListener("close", onClose);
      ws.addEventListener("error", onError);
    });
  }

  /** Routes one unwrapped session message to its waiter, if any. */
  deliver(msg) {
    if (msg.type === "rpc_error" && typeof msg.payload?.requestId === "string") {
      const waiter = this.waiters.get(msg.payload.requestId);
      if (waiter !== undefined) {
        this.waiters.delete(msg.payload.requestId);
        const err = new Error(msg.payload.error ?? "daemon rpc error");
        err.rpc = true;
        err.code = msg.payload.code;
        waiter.fn(err);
      }
      return;
    }
    const requestId = msg.payload?.requestId;
    if (typeof requestId !== "string") return;
    const waiter = this.waiters.get(requestId);
    if (waiter === undefined) return;
    if (msg.type !== waiter.responseType) return;
    this.waiters.delete(requestId);
    waiter.fn(undefined, msg.payload);
  }

  get connected() {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Sends one RPC and resolves the response payload. Rejects with a
   * `.rpc` error for a daemon-side rpc_error, and with a
   * DaemonConnectionError when the socket gives out first.
   */
  request(message, { responseType, timeoutMs = 15_000 }) {
    if (!this.connected) return Promise.reject(new DaemonConnectionError("not connected"));
    const requestId = `factory-driver-${++this.requestCounter}-${randomUUID().slice(0, 8)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(requestId);
        reject(new Error(`no ${responseType} within ${timeoutMs}ms for ${message.type}`));
      }, timeoutMs);
      this.waiters.set(requestId, {
        responseType,
        fn: (err, payload) => {
          clearTimeout(timer);
          if (err !== undefined) reject(err);
          else resolve(payload);
        },
      });
      try {
        this.ws.send(JSON.stringify({ type: "session", message: { ...message, requestId } }));
      } catch (err) {
        this.waiters.delete(requestId);
        clearTimeout(timer);
        reject(new DaemonConnectionError(`send failed: ${err.message}`));
      }
    });
  }

  rejectAllPending(err) {
    for (const waiter of this.waiters.values()) waiter.fn(err, undefined);
    this.waiters.clear();
  }

  close() {
    try {
      this.ws?.close();
    } catch {}
    this.rejectAllPending(new DaemonConnectionError("the driver closed the connection"));
  }
}

export class DaemonConnectionError extends Error {}

/** Reconnect with re-read pid + credential — both change across a daemon restart (scout caveat). */
async function reconnect(rpc, log) {
  for (;;) {
    try {
      await rpc.connect();
      return;
    } catch (err) {
      log(`factory: daemon unreachable (${err.message}) — retrying in 5s`);
      await sleep(5_000);
    }
  }
}

/**
 * Creates the task's agent over the daemon RPC. `idempotencyKey` = the task
 * id (ticket 03 §3): a crash-safe re-run meets the same operation — same
 * intent returns the existing agent, a different intent surfaces a
 * structured `agent_request_key_conflict`, never a silent second agent.
 * `title` = the task id; the brief is the runbook template with the PATH
 * baked from this process's environment, and the contract's description
 * (when set) riding ahead of it as the assignment.
 */
export async function createTaskAgent(rpc, { task, provider, model, cwd, brief }) {
  const config = { provider, cwd, title: task, ...(model === undefined ? {} : { model }) };
  if (rpc.features?.creationLifecycle === true) {
    const payload = await rpc.request(
      { type: "agent.create.request", idempotencyKey: task, subscribe: true, config, initialPrompt: brief },
      { responseType: "agent.create.response", timeoutMs: CREATE_TIMEOUT_MS },
    );
    if (payload.error !== undefined && payload.error !== null) {
      const err = new Error(payload.error);
      err.code = payload.errorCode;
      throw err;
    }
    if (payload.agent?.id === undefined) throw new Error("agent creation returned no agent");
    return payload.agent.id;
  }
  // Legacy host: the keyed create cannot carry a prompt (COMPAT
  // creationLifecycle), so this path is unkeyed — re-run protection rests on
  // the operator's eyes. The trial daemon (0.10.3) advertises the feature.
  const payload = await rpc.request(
    { type: "create_agent_request", config, initialPrompt: brief },
    { responseType: "status", timeoutMs: CREATE_TIMEOUT_MS },
  );
  if (payload.status === "agent_create_failed") throw new Error(payload.error ?? "agent creation failed");
  if (payload.agent?.id === undefined) throw new Error("agent creation returned no agent");
  return payload.agent.id;
}

// ---- observe: poll snapshots to a terminal state, stall report-only (ticket 03 §5–6) -----------------

/**
 * A snapshot's verdict on the agent's run: finished (its turn is done — the
 * task's verdict now lives in the ledger), died (status error), closed, or
 * still going. `idle` with the prompt consumed and nothing pending counts as
 * finished even when the attention flag was cleared by another watcher.
 */
export function agentFate(agent) {
  if (agent.status === "error") {
    return { terminal: true, fate: "died", reason: typeof agent.lastError === "string" && agent.lastError !== "" ? agent.lastError : "agent status is error" };
  }
  if (agent.status === "closed") {
    return { terminal: true, fate: "closed", reason: "the agent was closed" };
  }
  const pending = Array.isArray(agent.pendingPermissions) ? agent.pendingPermissions.length : 0;
  if (agent.status === "idle" && (agent.attentionReason === "finished" || (agent.lastUserMessageAt !== null && agent.lastUserMessageAt !== undefined && pending === 0))) {
    return { terminal: true, fate: "finished" };
  }
  return { terminal: false };
}

/**
 * The observe loop: poll `fetch_agent` for every unfinished agent every
 * `pollMs`, reconnecting (with re-read pid + credential) whenever the socket
 * gives out — post-restart finish-vs-die comes from the daemon's persisted
 * record, which `fetch_agent` serves just as well. Only a daemon *answer*
 * (`rpc_error`, an agent that is gone) ends a task as died; a transport
 * hiccup or a slow poll is transient and simply tries again next tick —
 * "restart-tolerant, keep polling" must not misreport a live agent. No
 * overall timeout: the run ends when every agent is terminal or the operator
 * interrupts. `onTerminal` fires once per task, the moment it lands.
 */
export async function observeTasks(rpc, entries, { pollMs = POLL_MS, log = () => {}, onTerminal = () => {} } = {}) {
  for (const entry of entries) {
    entry.terminal = undefined;
    entry.printedStatus = undefined;
    entry.timelineSeq = -1;
    entry.timelineStillSince = Date.now();
    entry.warned = false;
    entry.missingSince = undefined;
  }
  while (entries.some((e) => e.terminal === undefined)) {
    for (const entry of entries) {
      if (entry.terminal !== undefined) continue;
      let snapshot;
      try {
        if (!rpc.connected) await reconnect(rpc, log);
        const payload = await rpc.request({ type: "fetch_agent_request", agentId: entry.agentId }, { responseType: "fetch_agent_response" });
        if (payload.error !== undefined && payload.error !== null) throw rpcError(payload.error);
        if (payload.agent === null || payload.agent === undefined) {
          // Daemon 0.11 answers a single-agent fetch with null while the agent
          // is mid-run (and right after create — a registration race). The
          // agents-list RPC that would disambiguate is not answered on the
          // session socket (verified live: the request is silently dropped),
          // so a null is waited out — only one persisting past
          // AGENT_MISSING_DEAD_MS is called a death. Slow-but-alive agents
          // outrun the window and their verdicts still land in the ledger,
          // which is what the run reads.
          if (entry.missingSince === undefined) {
            entry.missingSince = Date.now();
          } else if (Date.now() - entry.missingSince > AGENT_MISSING_DEAD_MS) {
            throw rpcError("agent not found — the daemon no longer has its record");
          }
          continue;
        }
        entry.missingSince = undefined;
        snapshot = payload.agent;
      } catch (err) {
        if (err.rpc === true) {
          // The daemon answered: the agent is gone. That is a death, reported.
          entry.terminal = { fate: "died", reason: err.message };
          onTerminal(entry);
          continue;
        }
        // Connection trouble or a slow poll — transient, never a verdict.
        // The next tick retries; a daemon that never comes back is the
        // operator's interrupt, not a row of dead agents.
        log(`factory: ${entry.task} snapshot failed (${err.message}) — retrying next poll`);
        continue;
      }
      const fate = agentFate(snapshot);
      if (snapshot.status !== entry.printedStatus) {
        entry.printedStatus = snapshot.status;
        log(`factory: ${entry.task} agent ${snapshot.status}${snapshot.attentionReason === undefined ? "" : ` (${snapshot.attentionReason})`}`);
      }
      if (fate.terminal) {
        entry.terminal = fate;
        onTerminal(entry);
        continue;
      }
      await stallWatch(rpc, entry, snapshot, log).catch(() => {}); // a failed timeline read must not sink the poll
    }
    if (entries.some((e) => e.terminal === undefined)) await sleep(pollMs);
  }
}

function rpcError(message) {
  const err = new Error(message);
  err.rpc = true;
  return err;
}

/**
 * Stall is a judgment the daemon does not make (scout §c): status `running`
 * with a timeline that has not grown, or an ask parked past the threshold.
 * Report-only — the driver never kills an agent; the warning prints once.
 */
async function stallWatch(rpc, entry, snapshot, log) {
  const now = Date.now();
  const pending = Array.isArray(snapshot.pendingPermissions) ? snapshot.pendingPermissions.length : 0;
  if (pending > 0) {
    if (!entry.warned && now - entry.timelineStillSince >= STALL_WARN_MS) {
      entry.warned = true;
      log(`factory: ${entry.task} stall warning: parked on a permission ask for ${Math.round((now - entry.timelineStillSince) / 1000)}s — still waiting (report-only)`);
    }
    return;
  }
  if (snapshot.status !== "running") {
    entry.timelineStillSince = now;
    return;
  }
  const payload = await rpc.request(
    { type: "fetch_agent_timeline_request", agentId: entry.agentId, direction: "tail", limit: 5 },
    { responseType: "fetch_agent_timeline_response" },
  );
  let seq = entry.timelineSeq;
  for (const item of Array.isArray(payload.entries) ? payload.entries : []) {
    if (typeof item.seqEnd === "number" && item.seqEnd > seq) seq = item.seqEnd;
  }
  if (seq !== entry.timelineSeq) {
    entry.timelineSeq = seq;
    entry.timelineStillSince = now;
    return;
  }
  if (!entry.warned && now - entry.timelineStillSince >= STALL_WARN_MS) {
    entry.warned = true;
    log(`factory: ${entry.task} stall warning: running with no timeline growth for ${Math.round((now - entry.timelineStillSince) / 1000)}s — still waiting (report-only)`);
  }
}

// ---- the command -----------------------------------------------------------------------------------------------------

/**
 * `factory run` end to end: per task — local sanity + branch (exit-2
 * refusals, no spool request, no ledger line), the spool's `spawn` request
 * (the plugin appends `spawn_dispatched`/`spawn_refused`), then the agent
 * created over the daemon RPC, staggered. Then one observe loop to everyone's
 * terminal state, verdicts read from the ledger. Exit 0 iff every task ended
 * green and nothing was refused or failed along the way; else exit 2.
 */
export async function runDriver({ home, stateDir, spoolRoot, tasks, provider, waitSecs = 60, pollMs = POLL_MS, staggerMs = STAGGER_MS, log = (m) => console.log(m) }) {
  // These change spawn routing when the driver itself runs under an agent —
  // the driver spawns as itself, never as somebody's child (scout §a caveat).
  delete process.env.PASEO_AGENT_ID;
  delete process.env.PASEO_WORKSPACE_ID;

  const say = log;
  // Per-task failures (local refusals, spawn refusals, no reply, create
  // failures) — printed as they happen, counted for the exit code.
  const problems = [];
  const bad = (task, status, reason) => {
    say(`factory: ${task} ${status} — ${reason}`);
    problems.push(task);
  };
  const { provider: providerId, model } = splitProvider(provider);
  say(`factory: run ${tasks.join(" ")} (n=${tasks.length}) — provider ${provider}${model === undefined ? "" : `/${model}`}`);

  // The daemon is preflighted before any spawn line lands in the ledger: a
  // dispatched spawn with no agent behind it would be a lie the ledger keeps.
  const rpc = new DaemonRpc(home);
  try {
    await rpc.connect();
  } catch (err) {
    say(`factory: cannot reach the daemon — ${err.message}`);
    return 2;
  }

  const ledgerAtStart = readDriverLedger(stateDir);
  const entries = [];
  let created = 0;
  for (const task of tasks) {
    if (!TASK_ID_PATTERN.test(task)) {
      problems.push(bad(task, "refused locally", `task id "${task}" is invalid — use letters, digits, ".", "_", "-"`));
      continue;
    }
    const contract = contractFromLedger(ledgerAtStart, task);
    if (contract !== undefined) {
      const prep = prepareWorkspace(contract.workspace, task);
      if (!prep.ok) {
        problems.push(bad(task, "refused locally", prep.reason));
        continue;
      }
      say(`factory: ${task} on branch ${task}${prep.branchExisted ? " (existing — re-run)" : " (created)"}`);
    }
    // The spool owns the record: one spawn request per task, one ledger line
    // either way. Unknown tasks ride this path too — the plugin's refusal is
    // the recorded fact, not a local complaint.
    const request = { id: randomId(), kind: "spawn", task, provider, arity: tasks.length };
    submit(spoolRoot, request);
    const reply = await awaitReply(spoolRoot, request.id, waitSecs * 1000);
    if (reply === null) {
      problems.push(bad(task, "no reply", `the factory plugin did not answer the spawn request within ${waitSecs}s — the request (${request.id}) stays in the spool`));
      continue;
    }
    if (!reply.ok) {
      problems.push(bad(task, "spawn refused", `${reply.code}: ${reply.message}`));
      continue;
    }
    if (contract === undefined) {
      // The plugin knows a contract the driver's local read did not (it was
      // set moments ago) — record the oddity rather than guess a workspace.
      problems.push(bad(task, "agent create failed", "the plugin dispatched a spawn the driver has no local contract for — re-read the ledger and re-run"));
      continue;
    }
    if (created > 0) await sleep(staggerMs); // CPU etiquette only — gates must not serialize (ticket 03 §7)
    try {
      const brief = renderBrief(task, process.env.PATH ?? "", contract.description);
      const agentId = await createTaskAgent(rpc, {
        task,
        provider: providerId,
        ...(model === undefined ? {} : { model }),
        cwd: contract.workspace,
        brief,
      });
      entries.push({ task, agentId });
      created += 1;
      say(`factory: ${task} agent ${agentId.slice(0, 12)} created — watching to verdict`);
    } catch (err) {
      problems.push(bad(task, "agent create failed", `${err.code !== undefined ? `${err.code}: ` : ""}${err.message}`));
    }
  }

  // Each task's verdict is printed the moment its agent turns terminal
  // (ticket 03 §5: "at each task's verdict"), from a fresh ledger read —
  // the plugin wrote the verdict while the agent worked.
  await observeTasks(rpc, entries, {
    pollMs,
    log: say,
    onTerminal: (entry) => {
      if (entry.terminal.fate !== "finished") {
        say(`factory: ${entry.task} agent ${entry.terminal.fate} — ${entry.terminal.reason ?? "no reason given"}`);
      }
      const outcome = taskOutcome(readDriverLedger(stateDir), entry.task);
      say(
        [
          `factory: ${entry.task} — attempt ${outcome.attempt === 0 ? "-" : outcome.attempt}`,
          `verdict=${outcome.verdict ?? "-"}`,
          `sha=${outcome.sha === undefined ? "-" : outcome.sha.slice(0, 7)}`,
          `report=${outcome.reportPath ?? "-"}`,
          `choke=${outcome.allowed}/${outcome.denied}/${outcome.blocked}`,
        ].join(" "),
      );
    },
  });
  rpc.close();

  // Exit judgement from the ledger as it stands NOW — a task the driver
  // refused, failed to create, or whose agent died is already reported above.
  const ledgerAtEnd = readDriverLedger(stateDir);
  let allGreen = entries.every((entry) => {
    if (entry.terminal?.fate !== "finished") return false;
    return taskOutcome(ledgerAtEnd, entry.task).verdict === "green";
  });
  if (problems.length > 0) allGreen = false;
  say(allGreen ? "factory: run green — every task verified" : "factory: run NOT green");
  return allGreen ? 0 : 2;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
