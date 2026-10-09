/**
 * Timestamp stamping for the trace lines.
 *
 * Exact width: always 6 characters (e.g. 1234 -> "001234"). Never
 * truncate, never vary — the digest parser indexes by position.
 */
export function stamp(ms: number): string {
  return String(Math.max(0, Math.trunc(ms))).padStart(6, "0");
}
