/**
 * paseo-factory core — the v0.0.1 verification loop as a plain module.
 *
 * Zero Paseo imports by design: the plugin shell (and anything else) loads
 * this and gets contract → ledger → gate → report. Written once, lives
 * forever (`research/03-hands-on/04-andrew-room.md` §12).
 */
export { createFactory } from "./factory.ts";
export type { Factory, FactoryOptions, ContractInput, ClaimInput, ClaimOutcome, AcceptInput, SpawnInput, SpawnDecision } from "./factory.ts";
export { resolveClaimedCommit, checkCleanAt, diffBetween } from "./workspace.ts";
export type { CommitResolution, TreeCheck } from "./workspace.ts";
export { Ledger } from "./ledger.ts";
export { runGate } from "./gate.ts";
export type { GateInput, GateResult } from "./gate.ts";
export { eyeConfigPath, loadEyeConfig, runFreshEyesPass, tailWithMarker, parseEyeAnswer } from "./fresh-eyes.ts";
export type { EyeConfig, EyeConfigResult, FreshEyesOutcome, FreshEyesPassInput, ParsedEyeAnswer } from "./fresh-eyes.ts";
export {
  SELF_ACCEPT_CODE_ANSWER,
  WATCH_MODEL,
  WATCH_QUESTIONS,
  buildCodeAnswers,
  loadWatchConfig,
  renderTimelineTranscript,
  runWatchPass,
  watchConfigPath,
} from "./watch.ts";
export type {
  CodeAnswersInput,
  TimelineFetcher,
  TimelineFetchResult,
  WatchConfig,
  WatchConfigResult,
  WatchOutcome,
  WatchPassInput,
  WatchQuestion,
  WatchTimelineEntry,
} from "./watch.ts";
export { renderReport } from "./report.ts";
export { FactoryError } from "./errors.ts";
export {
  judgeShellCommand,
  judgeFilePath,
  refuseGitArgv,
  shellTokens,
  writableRootsFor,
} from "./choke.ts";
export type { ChokeDecision, GitRefusal, WritableRoots } from "./choke.ts";
export {
  DEFAULT_GATE_TIMEOUT_MS,
  GATE_OUTPUT_CAP_BYTES,
  REPORT_NOTE_MAX_CHARS,
  EYE_TOTAL_BUDGET_MS,
  EYE_DIFF_MAX_CHARS,
  EYE_GATE_OUTPUT_MAX_CHARS,
  EYE_MAX_TOKENS,
  WATCH_TOTAL_BUDGET_MS,
  WATCH_TIMELINE_MAX_CHARS,
  WATCH_DIFF_MAX_CHARS,
  WATCH_GATE_OUTPUT_MAX_CHARS,
  WATCH_PROMPT_TOKEN_GUARD,
  WATCH_CHARS_PER_TOKEN,
  WATCH_CALLOUT_THRESHOLD,
  WATCH_COST_PER_MTOK,
} from "./constants.ts";
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
  FreshEyesWritten,
  WatchWritten,
  ReportWritten,
  AttemptAccepted,
  PermitAllowed,
  PermitDenied,
  GitBlocked,
  SpawnDispatched,
  SpawnRefused,
} from "./events.ts";
export { EVENT_NAMES } from "./events.ts";
