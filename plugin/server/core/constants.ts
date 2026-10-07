/** Shared tuning knobs for the core. v0.0.1 values — revisit after the first live run. */

/** Default gate timeout: kill the process group and record red after this long. */
export const DEFAULT_GATE_TIMEOUT_MS = 5 * 60_000;

/** Keep at most this many bytes of stdout/stderr, measured from the end (the summary lives at the end). */
export const STDOUT_TAIL_CAP_BYTES = 4_096;

/** The ledger's single-line `note` field is capped to this many characters. */
export const REPORT_NOTE_MAX_CHARS = 200;
