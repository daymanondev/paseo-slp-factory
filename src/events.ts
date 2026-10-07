/**
 * Ledger event shapes — the v0.0.1 contract with the roadmap doc
 * (`research/03-hands-on/05-lo-trinh-paseo-factory.md` §2). Field names and
 * shapes are fixed there; the five events are the whole vocabulary. The one
 * rename since — `claim_reported` — is ADR 0003, which supersedes §2's
 * `done_reported`: the Agent makes a Claim, never "done".
 */

export type Verdict = "red" | "green";

/** The whole event vocabulary, in ledger order — single source for types and validation. */
export const EVENT_NAMES = [
  "contract_set",
  "claim_reported",
  "gate_started",
  "gate_finished",
  "report_written",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

export interface ContractSet {
  seq: number;
  event: "contract_set";
  task: string;
  gate: string;
  artifact: string;
}

export interface ClaimReported {
  seq: number;
  event: "claim_reported";
  task: string;
  /** The Agent's raw claimed sha — its exact word, resolved later by the gate station. */
  sha: string;
}

export interface GateStarted {
  seq: number;
  event: "gate_started";
  task: string;
  cmd: string;
}

export interface GateFinished {
  seq: number;
  event: "gate_finished";
  task: string;
  /** Process exit code, or null when the gate was killed (timeout / signal) or never ran. */
  exit: number | null;
  verdict: Verdict;
  note: string;
  /** The full commit the Verdict attests — present whenever the claimed sha resolved (ADR 0002). */
  sha?: string;
}

export interface ReportWritten {
  seq: number;
  event: "report_written";
  task: string;
  path: string;
}

export type LedgerEvent = ContractSet | ClaimReported | GateStarted | GateFinished | ReportWritten;

/** What callers hand to Ledger.append — same shape, seq not yet assigned. */
export type PendingEvent =
  | Omit<ContractSet, "seq">
  | Omit<ClaimReported, "seq">
  | Omit<GateStarted, "seq">
  | Omit<GateFinished, "seq">
  | Omit<ReportWritten, "seq">;
