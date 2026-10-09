/**
 * The spool (ADR 0004): the plugin process is the only Ledger writer and the
 * only Gate runner; the CLIs (`factory-claim`, `factory contract`,
 * `factory accept`) only submit. A CLI drops a request file and waits for the
 * reply file — no RPC, no shared process, so the protocol survives daemon
 * restarts and never hands the Ledger to an agent's process.
 *
 * Protocol — the plugin side lives here, the CLI side in
 * `plugin/bin/spool-client.mjs`, and `test/cli.test.ts` runs both halves
 * against each other so they cannot drift:
 *
 *   request:  spool/requests/<id>.json   {id, kind, ...}   written atomically
 *   reply:    spool/replies/<id>.json    {id, ok, ...}     written atomically
 *   handled:  spool/processed/<id>.json  the request file, moved after reply
 *
 * Each request carries an id: a request whose reply already exists is moved
 * along untouched, so a retried or replayed request never starts a second
 * Gate. What a plugin crash mid-gate looks like is ADR 0003's business — the
 * interrupted Attempt is closed red on the next open, and the still-unreplied
 * request is processed again on boot, opening the next Attempt honestly.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FactoryError } from "./core/errors.ts";
import type { Factory } from "./core/factory.ts";
import type { Verdict } from "./core/events.ts";

export interface ContractRequest {
  id: string;
  kind: "contract";
  task: string;
  workspace: string;
  gate: string;
  artifact: string;
  scope?: string[];
  /** Marks the fresh-eyes pass ON (ADR 0005 default: off). Exactly `true` passes; anything else is rejected. */
  freshEyes?: true;
  /** Marks the watch pass ON (v0.0.6, record-only, both verdicts). Exactly `true` passes; anything else is rejected. */
  watch?: true;
  /** The task's assignment text (v0.0.6 description-slot rider) — the driver's brief carries it. */
  description?: string;
}

export interface ClaimRequest {
  id: string;
  kind: "claim";
  task: string;
  sha: string;
  /** Who submitted, when the daemon stamps it on the agent's env — for the spool log, not the ledger. */
  agent?: string;
}

export interface AcceptRequest {
  id: string;
  kind: "accept";
  task: string;
  attempt: number;
}

/**
 * A driver's spawn request (v0.0.5, ADR 0004 amendment): `factory run` asks
 * the plugin — the one writer — whether it may create this task's agent.
 * The plugin judges (task state, scope-mandatory at arity ≥ 2, workspace
 * overlap) and appends one ledger line either way; only on ok does the
 * driver perform its own daemon RPC create. `provider` is recorded on the
 * line, never interpreted; `arity` is the invocation's task count — the
 * parallel width the scope rule keys on.
 */
export interface SpawnRequest {
  id: string;
  kind: "spawn";
  task: string;
  provider: string;
  arity: number;
}

/**
 * A synthetic permit ask (v0.0.4) — the bypass battery's vehicle into the real
 * choke: the same policy, the same ledger lines, answered in the reply instead
 * of `respondToPermission()` because no daemon ask exists to answer. The task
 * must carry a live Contract covering `cwd` (default: the Contract's own
 * workspace) — the choke judges contracted work only.
 */
export interface AskRequest {
  id: string;
  kind: "ask";
  task: string;
  command: string;
  cwd?: string;
  agent?: string;
  name?: string;
}

export type SpoolRequest = ContractRequest | ClaimRequest | AcceptRequest | AskRequest | SpawnRequest;

/** Handles a synthetic ask — `createChoke(...).spoolAskHandler` is the implementation. */
export type AskHandler = (request: AskRequest) => SpoolReply;

export type SpoolReply =
  | {
      id: string;
      ok: true;
      summary: string;
      /** Claim replies: which Attempt the Claim opened and how it ended. */
      attempt?: number;
      verdict?: Verdict;
      reportPath?: string;
      /** The gate note — the agent's actionable feedback on a red verdict. */
      note?: string;
      /** Ask replies: the choke's answer. A denial is a processed ask, not an error. */
      decision?: "allowed" | "denied";
      rule?: string;
      reason?: string;
    }
  | { id: string; ok: false; code: string; message: string };

/** Where all three spool directories live. */
export function spoolRootFor(stateDir: string): string {
  return join(stateDir, "spool");
}

/**
 * Validates one decoded request body. Anything that does not match a kind's
 * exact shape is rejected — the spool never guesses what a CLI meant.
 */
export function parseSpoolRequest(body: unknown): SpoolRequest | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const req = body as Record<string, unknown>;
  if (typeof req.id !== "string" || req.id === "") return undefined;
  if (req.kind === "contract") {
    if (typeof req.task !== "string" || typeof req.workspace !== "string" || typeof req.gate !== "string" || typeof req.artifact !== "string") {
      return undefined;
    }
    const scope = req.scope;
    if (scope !== undefined && (!Array.isArray(scope) || scope.some((s) => typeof s !== "string"))) return undefined;
    if (req.freshEyes !== undefined && req.freshEyes !== true) return undefined;
    if (req.watch !== undefined && req.watch !== true) return undefined;
    if (req.description !== undefined && (typeof req.description !== "string" || req.description.trim() === "")) return undefined;
    return {
      id: req.id,
      kind: "contract",
      task: req.task,
      workspace: req.workspace,
      gate: req.gate,
      artifact: req.artifact,
      ...(scope === undefined ? {} : { scope: scope as string[] }),
      ...(req.freshEyes === undefined ? {} : { freshEyes: true }),
      ...(req.watch === undefined ? {} : { watch: true }),
      ...(req.description === undefined ? {} : { description: req.description }),
    };
  }
  if (req.kind === "claim") {
    if (typeof req.task !== "string" || typeof req.sha !== "string") return undefined;
    if (req.agent !== undefined && typeof req.agent !== "string") return undefined;
    return { id: req.id, kind: "claim", task: req.task, sha: req.sha, ...(req.agent === undefined ? {} : { agent: req.agent }) };
  }
  if (req.kind === "accept") {
    if (typeof req.task !== "string" || typeof req.attempt !== "number" || !Number.isInteger(req.attempt)) return undefined;
    return { id: req.id, kind: "accept", task: req.task, attempt: req.attempt };
  }
  if (req.kind === "spawn") {
    if (typeof req.task !== "string" || typeof req.provider !== "string" || typeof req.arity !== "number" || !Number.isInteger(req.arity) || req.arity < 1) {
      return undefined;
    }
    return { id: req.id, kind: "spawn", task: req.task, provider: req.provider, arity: req.arity };
  }
  if (req.kind === "ask") {
    if (typeof req.task !== "string" || typeof req.command !== "string" || req.command.trim() === "") return undefined;
    for (const field of ["cwd", "agent", "name"] as const) {
      if (req[field] !== undefined && typeof req[field] !== "string") return undefined;
    }
    return {
      id: req.id,
      kind: "ask",
      task: req.task,
      command: req.command,
      ...(req.cwd === undefined ? {} : { cwd: req.cwd as string }),
      ...(req.agent === undefined ? {} : { agent: req.agent as string }),
      ...(req.name === undefined ? {} : { name: req.name as string }),
    };
  }
  return undefined;
}

/**
 * Runs one request through the factory — the single place a spool request
 * becomes Ledger events or a Gate run. Never throws: every failure becomes a
 * red-flagged reply, so the waiting CLI always hears something. `ask` requests
 * need the choke's handler (the shell passes `createChoke(...).spoolAskHandler`);
 * without one they are refused loudly, never silently allowed.
 */
export async function handleSpoolRequest(
  factory: Factory,
  request: SpoolRequest,
  askHandler?: AskHandler,
): Promise<SpoolReply> {
  try {
    if (request.kind === "contract") {
      factory.setContract({
        task: request.task,
        workspace: request.workspace,
        gate: request.gate,
        artifact: request.artifact,
        ...(request.scope === undefined ? {} : { scope: request.scope }),
        ...(request.freshEyes === undefined ? {} : { freshEyes: true }),
        ...(request.watch === undefined ? {} : { watch: true }),
        ...(request.description === undefined ? {} : { description: request.description }),
      });
      return {
        id: request.id,
        ok: true,
        summary:
          `contract set for ${request.task}: \`${request.gate}\` in ${request.workspace}` +
          `${request.freshEyes === true ? " · fresh eyes ON" : ""}${request.watch === true ? " · watch ON" : ""}`,
      };
    }
    if (request.kind === "claim") {
      const outcome = await factory.claim({
        task: request.task,
        sha: request.sha,
        ...(request.agent === undefined ? {} : { agent: request.agent }),
      });
      return {
        id: request.id,
        ok: true,
        summary: `task ${request.task} attempt ${outcome.attempt}: ${outcome.verdict.toUpperCase()}`,
        attempt: outcome.attempt,
        verdict: outcome.verdict,
        reportPath: outcome.reportPath,
        note: outcome.gate.note,
      };
    }
    if (request.kind === "ask") {
      if (askHandler === undefined) {
        return {
          id: request.id,
          ok: false,
          code: "ask-unavailable",
          message: "this daemon's factory plugin does not judge synthetic asks — update the plugin to v0.0.4+",
        };
      }
      return askHandler(request);
    }
    if (request.kind === "spawn") {
      // The driver's arrival (v0.0.5): one ledger line either way, then the
      // reply the driver keys its next move on — create the agent, or report
      // the refusal and carry on with the invocation's other tasks.
      const decision = factory.requestSpawn({ task: request.task, provider: request.provider, arity: request.arity });
      if (decision.outcome === "refused") {
        return { id: request.id, ok: false, code: decision.code, message: decision.event.reason };
      }
      return {
        id: request.id,
        ok: true,
        summary: `spawn dispatched for ${request.task} under ${request.provider} (n=${request.arity})`,
      };
    }
    factory.accept({ task: request.task, attempt: request.attempt });
    return { id: request.id, ok: true, summary: `task ${request.task} accepted at attempt ${request.attempt}` };
  } catch (err) {
    if (err instanceof FactoryError) {
      return { id: request.id, ok: false, code: err.code, message: err.message };
    }
    return {
      id: request.id,
      ok: false,
      code: "plugin-error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface SpoolOptions {
  /** Called once per handled request — the shell prefixes and prints it. */
  onLog?: (message: string) => void;
  /** Reply poll cadence for the drain loop. Default 250ms. */
  pollMs?: number;
  /** The choke's synthetic-ask handler (v0.0.4); without it `ask` requests are refused. */
  ask?: AskHandler;
}

export interface Spool {
  stop(): void;
}

/**
 * The submit side of the loop: poll `requests/`, handle each new id, write the
 * reply, move the request to `processed/`. Requests are handled concurrently —
 * a long Gate must not delay the Owner's contract or accept — which is safe
 * because the factory itself refuses overlapping Attempts on one task.
 */
export function startSpool(stateDir: string, factory: Factory, options: SpoolOptions = {}): Spool {
  const root = spoolRootFor(stateDir);
  const requestsDir = join(root, "requests");
  const repliesDir = join(root, "replies");
  const processedDir = join(root, "processed");
  mkdirSync(requestsDir, { recursive: true });
  mkdirSync(repliesDir, { recursive: true });
  mkdirSync(processedDir, { recursive: true });

  const log = options.onLog ?? (() => {});
  const inFlight = new Set<string>();

  const drain = (): void => {
    for (const name of readdirSync(requestsDir).sort()) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      if (inFlight.has(id)) continue;
      const requestPath = join(requestsDir, name);
      const replyPath = join(repliesDir, name);
      if (existsSync(replyPath)) {
        // Already answered (retried or replayed request): pass it along, run nothing.
        renameSync(requestPath, join(processedDir, name));
        log(`request ${id}: reply already existed — skipped (no second gate)`);
        continue;
      }
      inFlight.add(id);
      void handleRequestFile(id, requestPath, replyPath, join(processedDir, name), factory, log, options.ask)
        .catch(() => {})
        .finally(() => inFlight.delete(id));
    }
  };

  const timer = setInterval(drain, options.pollMs ?? 250);
  drain();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

async function handleRequestFile(
  id: string,
  requestPath: string,
  replyPath: string,
  processedPath: string,
  factory: Factory,
  log: (message: string) => void,
  askHandler?: AskHandler,
): Promise<void> {
  let reply: SpoolReply;
  let request: SpoolRequest | undefined;
  try {
    request = parseSpoolRequest(JSON.parse(readFileSync(requestPath, "utf8")));
  } catch {
    request = undefined;
  }
  if (request === undefined) {
    reply = { id, ok: false, code: "bad-request", message: `request file ${requestPath} is not a valid spool request` };
    log(`request ${id}: REJECTED — malformed`);
  } else {
    reply = await handleSpoolRequest(factory, request, askHandler);
    log(
      request.kind === "claim" && reply.ok
        ? `request ${id}: claim ${request.task} by ${request.agent ?? "unknown agent"} → attempt ${reply.attempt} ${reply.verdict}`
        : `request ${id}: ${request.kind} ${request.task} → ${reply.ok ? (reply.decision ?? "ok") : `rejected (${reply.code})`}`,
    );
  }
  writeJsonAtomic(replyPath, reply);
  renameSync(requestPath, processedPath);
}

/** Write-then-rename, so a reader never sees a half-written JSON file. */
function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`);
  renameSync(tmp, path);
}
