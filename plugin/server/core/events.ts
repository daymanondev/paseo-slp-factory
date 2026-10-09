/**
 * Ledger event shapes — the v0.0.1 contract with the roadmap doc
 * (`research/03-hands-on/05-lo-trinh-paseo-factory.md` §2), as amended by the
 * ADRs. The five §2 events keep their order; the changes on top: every event
 * carries `ts` (ADR 0003), every event after the Contract carries the Attempt
 * number it belongs to (ADR 0003), the Contract fixes the Workspace (ticket 08
 * / ADR 0002 — the Owner chooses where the Gate runs, never the Agent), and
 * `claim_reported` replaces §2's `done_reported` (ADR 0003: the Agent makes a
 * Claim, never "done"). `attempt_accepted` is ADR 0002: only the Owner accepts,
 * and acceptance names one green Attempt. `fresh_eyes_written` is v0.0.2
 * (ticket 03): one advisory line between a green `gate_finished` and its
 * `report_written` — evidence for the Owner, never a second Verdict.
 * The choke events (`permit_allowed` / `permit_denied` / `git_blocked`,
 * v0.0.4) are task-scoped but NOT attempt-scoped: a permit ask belongs to
 * the work before any Claim, and a git block to any moment — so they carry
 * no `attempt`, and `git_blocked` may carry no `task` at all (the shim
 * refuses no matter who runs it; the ledger records what it can bind).
 * The spawn events (`spawn_dispatched` / `spawn_refused`, v0.0.5) are the
 * driver's arrival in the ledger: the plugin records one line per spawn
 * request — allowed or refused — before any agent exists, so they too carry
 * no `attempt` (ADR 0004's amendment: the driver never writes, the plugin
 * validates and records).
 */

export type Verdict = "red" | "green";

/**
 * The whole event vocabulary — single source for types and validation. The
 * first seven are the attempt-scoped loop in ledger order; the choke
 * vocabulary (v0.0.4) and the spawn vocabulary (v0.0.5) follow, appended
 * after their host loops.
 */
export const EVENT_NAMES = [
  "contract_set",
  "claim_reported",
  "gate_started",
  "gate_finished",
  "fresh_eyes_written",
  "report_written",
  "attempt_accepted",
  "permit_allowed",
  "permit_denied",
  "git_blocked",
  "spawn_dispatched",
  "spawn_refused",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

/** Assigned by the ledger at append time — ISO 8601 UTC (ADR 0003). */
export type Timestamp = string;

export interface ContractSet {
  seq: number;
  ts: Timestamp;
  event: "contract_set";
  task: string;
  /** The Workspace fixed by the Owner — the Gate's cwd and the artifact base. Absolute path. */
  workspace: string;
  gate: string;
  artifact: string;
  /** Path prefixes (workspace-relative) the task may touch. Omitted = unrestricted. */
  scope?: string[];
  /**
   * The commit the Workspace sat at when the Contract was set — the diff base
   * for the scope check and the fresh-eyes pass. Recorded on every Contract
   * since v0.0.2 (ticket 03 R2); pre-0.0.2 Contracts predate it.
   */
  base?: string;
  /** Marks the fresh-eyes pass ON for this task (ADR 0005 default: off). */
  freshEyes?: true;
}

export interface ClaimReported {
  seq: number;
  ts: Timestamp;
  event: "claim_reported";
  task: string;
  /** The Attempt this Claim opened — assigned by the factory, numbered from 1 per task. */
  attempt: number;
  /** The Agent's raw claimed sha — its exact word, resolved later by the gate station. */
  sha: string;
  /**
   * Who claimed, when the plugin knows the submitter (spool claims stamped
   * with the agent id; direct CLI claims carry no spool, so no agent).
   */
  agent?: string;
}

export interface GateStarted {
  seq: number;
  ts: Timestamp;
  event: "gate_started";
  task: string;
  attempt: number;
  cmd: string;
}

export interface GateFinished {
  seq: number;
  ts: Timestamp;
  event: "gate_finished";
  task: string;
  attempt: number;
  /** Process exit code, or null when the gate was killed (timeout / signal) or never ran. */
  exit: number | null;
  verdict: Verdict;
  note: string;
  /** The full commit the Verdict attests — present whenever the claimed sha resolved (ADR 0002). */
  sha?: string;
  /**
   * The persisted full gate output (`gate-<task>-<attempt>.log` in stateDir),
   * present whenever the gate ran — the ledger alone can find the evidence
   * (ticket 02a). The `note` stays a one-line summary.
   */
  outputPath?: string;
}

/**
 * The fresh-eyes line (ticket 03): one read-only pass by a different model
 * after a green Verdict. `outcome` is the countable noise instrument; on
 * `failed`, `finding` carries the error — deaths are visible, never swallowed.
 */
export interface FreshEyesWritten {
  seq: number;
  ts: Timestamp;
  event: "fresh_eyes_written";
  task: string;
  attempt: number;
  /** The model id actually used, from the plugin's eye config (ticket 04). */
  model: string;
  outcome: "concern" | "clear" | "failed";
  /** The eye's words, ≤ ~120 words — "what did the eye see". */
  finding: string;
  /** Pass latency, for the 0.0.2 live run's cost/noise questions. */
  durationMs: number;
}

export interface ReportWritten {
  seq: number;
  ts: Timestamp;
  event: "report_written";
  task: string;
  attempt: number;
  path: string;
}

export interface AttemptAccepted {
  seq: number;
  ts: Timestamp;
  event: "attempt_accepted";
  task: string;
  attempt: number;
}

/**
 * The choke allowed a contracted agent's permit ask (v0.0.4). One line per
 * judged ask — allowed asks are the permit parade made countable; paseo
 * persists permission decisions nowhere, so this line is the only record.
 */
export interface PermitAllowed {
  seq: number;
  ts: Timestamp;
  event: "permit_allowed";
  /** The task whose live Contract bound the asking agent to the choke. */
  task: string;
  /** The asking agent's id — a daemon agent, or the spool asker's name. */
  agent: string;
  /** The tool name from the ask (e.g. `Bash`, `Write`). */
  name: string;
  /** The ask kind: "tool" | "plan" | "question" | "mode" | "other". */
  kind: string;
  /** What the ask aimed at: the exact shell line (`detail.command`), or the write/edit ask's target file path. */
  command?: string;
}

/** The choke denied a contracted agent's permit ask — one line, rule and reason named. */
export interface PermitDenied extends Omit<PermitAllowed, "event"> {
  event: "permit_denied";
  /** Which deny-list entry fired (e.g. `policy:S1-git-vocabulary`). */
  rule: string;
  /** One line saying what the rule caught. */
  reason: string;
}

/**
 * The git shim refused a dangerous argv at exec time (v0.0.4). Written by the
 * plugin from the shim's log line, deduplicated by `blockId` across plugin
 * lifetimes. `task` is present exactly when the refusal's cwd sat inside a
 * live Contract's workspace — the shim refuses regardless.
 */
export interface GitBlocked {
  seq: number;
  ts: Timestamp;
  event: "git_blocked";
  task?: string;
  /** The agent whose shell ran the refused git, when the daemon stamped one. */
  agent?: string;
  /** The refused argv, joined back into one line. */
  command: string;
  /** Which refusal-list class fired (e.g. `git:force-push`). */
  rule: string;
  reason: string;
  /** The shell's cwd at the refusal — what bound it to a task, or did not. */
  cwd: string;
  /** The shim log line's id — ingestion's exactly-once key. */
  blockId: string;
}

/**
 * The plugin let a driver's spawn request through (v0.0.5, ADR 0004
 * amendment): the task's Contract checked out against the spawn rules —
 * known, unaccepted, scoped when the invocation runs parallel, workspace
 * clear of other live Contracts — and the driver may now create the agent.
 * The agent id is deliberately absent: the plugin writes this line before
 * the agent exists (the driver's RPC create comes after the ok).
 */
export interface SpawnDispatched {
  seq: number;
  ts: Timestamp;
  event: "spawn_dispatched";
  task: string;
  /** The `provider[/model]` string the driver asked to run the task under. */
  provider: string;
  /** How many tasks the spawning invocation carried — the run's parallel width. */
  arity: number;
}

/**
 * The plugin refused a driver's spawn request — one line naming the rule
 * that fired, so a refused spawn is a recorded fact, not a CLI complaint.
 * No agent exists for this line; the driver reports it and moves on.
 */
export interface SpawnRefused {
  seq: number;
  ts: Timestamp;
  event: "spawn_refused";
  task: string;
  provider: string;
  arity: number;
  /** Which spawn validation fired (e.g. `spawn:scope-mandatory`). */
  rule: string;
  /** One line saying what the rule caught. */
  reason: string;
}

export type LedgerEvent =
  | ContractSet
  | ClaimReported
  | GateStarted
  | GateFinished
  | FreshEyesWritten
  | ReportWritten
  | AttemptAccepted
  | PermitAllowed
  | PermitDenied
  | GitBlocked
  | SpawnDispatched
  | SpawnRefused;

/** What callers hand to Ledger.append — same shape, `seq` and `ts` not yet assigned. */
export type PendingEvent =
  | Omit<ContractSet, "seq" | "ts">
  | Omit<ClaimReported, "seq" | "ts">
  | Omit<GateStarted, "seq" | "ts">
  | Omit<GateFinished, "seq" | "ts">
  | Omit<FreshEyesWritten, "seq" | "ts">
  | Omit<ReportWritten, "seq" | "ts">
  | Omit<AttemptAccepted, "seq" | "ts">
  | Omit<PermitAllowed, "seq" | "ts">
  | Omit<PermitDenied, "seq" | "ts">
  | Omit<GitBlocked, "seq" | "ts">
  | Omit<SpawnDispatched, "seq" | "ts">
  | Omit<SpawnRefused, "seq" | "ts">;
