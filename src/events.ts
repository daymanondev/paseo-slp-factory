/**
 * Ledger event shapes — the v0.0.1 contract with the roadmap doc
 * (`research/03-hands-on/05-lo-trinh-paseo-factory.md` §2), as amended by the
 * ADRs. The five §2 events keep their order; the changes on top: every event
 * carries `ts` (ADR 0003), every event after the Contract carries the Attempt
 * number it belongs to (ADR 0003), the Contract fixes the Workspace (ticket 08
 * / ADR 0002 — the Owner chooses where the Gate runs, never the Agent), and
 * `claim_reported` replaces §2's `done_reported` (ADR 0003: the Agent makes a
 * Claim, never "done"). `attempt_accepted` is ADR 0002: only the Owner accepts,
 * and acceptance names one green Attempt.
 */

export type Verdict = "red" | "green";

/** The whole event vocabulary, in ledger order — single source for types and validation. */
export const EVENT_NAMES = [
  "contract_set",
  "claim_reported",
  "gate_started",
  "gate_finished",
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
  /** The commit the Workspace sat at when the Contract was set — the diff base for the scope check. */
  base?: string;
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
  | ReportWritten
  | AttemptAccepted;

/** What callers hand to Ledger.append — same shape, `seq` and `ts` not yet assigned. */
export type PendingEvent =
  | Omit<ContractSet, "seq" | "ts">
  | Omit<ClaimReported, "seq" | "ts">
  | Omit<GateStarted, "seq" | "ts">
  | Omit<GateFinished, "seq" | "ts">
  | Omit<ReportWritten, "seq" | "ts">
  | Omit<AttemptAccepted, "seq" | "ts">;
