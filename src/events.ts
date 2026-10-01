/**
 * Ledger event shapes — the v0.0.1 contract with the roadmap doc
 * (`research/03-hands-on/05-lo-trinh-paseo-factory.md` §2). Field names and
 * shapes are fixed there; the five events are the whole vocabulary.
 */

export type Verdict = "red" | "green";

export interface ContractSet {
  seq: number;
  event: "contract_set";
  task: string;
  gate: string;
  artifact: string;
}

export interface DoneReported {
  seq: number;
  event: "done_reported";
  task: string;
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
  /** Process exit code, or null when the gate was killed (timeout / signal). */
  exit: number | null;
  verdict: Verdict;
  note: string;
}

export interface ReportWritten {
  seq: number;
  event: "report_written";
  task: string;
  path: string;
}

export type LedgerEvent = ContractSet | DoneReported | GateStarted | GateFinished | ReportWritten;

/** What callers hand to Ledger.append — same shape, seq not yet assigned. */
export type PendingEvent =
  | Omit<ContractSet, "seq">
  | Omit<DoneReported, "seq">
  | Omit<GateStarted, "seq">
  | Omit<GateFinished, "seq">
  | Omit<ReportWritten, "seq">;
