/**
 * paseo-factory core — the v0.0.1 verification loop as a plain module.
 *
 * Zero Paseo imports by design: the plugin shell (and anything else) loads
 * this and gets contract → ledger → gate → report. Written once, lives
 * forever (`research/03-hands-on/04-andrew-room.md` §12).
 */
export { createFactory } from "./factory.ts";
export type { Factory, FactoryOptions, ContractInput, ClaimInput, ClaimOutcome, AcceptInput } from "./factory.ts";
export { resolveClaimedCommit, checkCleanAt } from "./workspace.ts";
export type { CommitResolution, TreeCheck } from "./workspace.ts";
export { Ledger } from "./ledger.ts";
export { runGate } from "./gate.ts";
export type { GateInput, GateResult } from "./gate.ts";
export { renderReport } from "./report.ts";
export { FactoryError } from "./errors.ts";
export { DEFAULT_GATE_TIMEOUT_MS, REPORT_NOTE_MAX_CHARS, STDOUT_TAIL_CAP_BYTES } from "./constants.ts";
export type {
  Verdict,
  EventName,
  Timestamp,
  LedgerEvent,
  PendingEvent,
  ContractSet,
  ClaimReported,
  GateStarted,
  GateFinished,
  ReportWritten,
  AttemptAccepted,
} from "./events.ts";
export { EVENT_NAMES } from "./events.ts";
