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
 */

export type Verdict = "red" | "green";

/** The whole event vocabulary, in ledger order — single source for types and validation. */
export const EVENT_NAMES = [
  "contract_set",
  "claim_reported",
  "gate_started",
  "gate_finished",
  "fresh_eyes_written",
  "report_written",
  "attempt_accepted",
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

export type LedgerEvent =
  | ContractSet
  | ClaimReported
  | GateStarted
  | GateFinished
  | FreshEyesWritten
  | ReportWritten
  | AttemptAccepted;

/** What callers hand to Ledger.append — same shape, `seq` and `ts` not yet assigned. */
export type PendingEvent =
  | Omit<ContractSet, "seq" | "ts">
  | Omit<ClaimReported, "seq" | "ts">
  | Omit<GateStarted, "seq" | "ts">
  | Omit<GateFinished, "seq" | "ts">
  | Omit<FreshEyesWritten, "seq" | "ts">
  | Omit<ReportWritten, "seq" | "ts">
  | Omit<AttemptAccepted, "seq" | "ts">;
