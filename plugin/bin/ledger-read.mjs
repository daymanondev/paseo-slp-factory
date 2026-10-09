#!/usr/bin/env node
/**
 * The one ledger read both CLIs share — `factory status`'s glance and the
 * driver's verdict reads are the same file read under two policies.
 *
 * Plain .mjs like its siblings (the CLIs' law, ADR 0004): no build step, no
 * plugin server imports, `node:*` only. What every policy shares is the
 * writer's fsync-per-line contract (ADR 0003): a last line with no trailing
 * newline was never acknowledged, so it is ignored here — the same
 * forgiveness the core's open-time quarantine applies (src/ledger.ts), which
 * a reader mirrors because it never writes.
 */
import { readFileSync } from "node:fs";

/**
 * Reads the ledger at `path` and returns one verdict — never throws for
 * ledger content:
 *
 *   { missing: true }    no ledger yet (ENOENT) — the plugin has never run
 *                        on this home; a state, not an error
 *   { failed: error }    the read itself failed — the caller decides what
 *                        that means (status dies, the driver throws)
 *   { corrupt: reason }  a complete line no reader may guess around; the
 *                        reason is the caller's report line, verbatim
 *   { events }           the complete lines, parsed (and, with a validator,
 *                        shape-checked)
 *
 * With `validateEvent` (factory status's policy) the read is strict: a blank
 * line is corruption, and every event must be an object the validator
 * accepts — each refusal named with its line number ("line 3 is not a valid
 * ledger event"). Without one (the driver's policy) the ledger is trusted to
 * its only writer (ADR 0004), which validates each line when it appends it:
 * blank lines are skipped and only unparseable JSON is corruption — reported
 * without a line number, the driver's long-standing shape.
 */
export function readLedgerEvents(path, { validateEvent } = {}) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { missing: true };
    return { failed: err };
  }
  const strict = validateEvent !== undefined;
  const events = [];
  const lines = raw.split("\n");
  lines.pop(); // the "" after a final newline — or the unacknowledged unterminated tail
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const at = i + 1;
    if (strict) {
      if (line === "") return { corrupt: `blank line at line ${at}` };
    } else if (line.trim() === "") {
      continue; // the driver skips blank lines; status refuses them
    }
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      return { corrupt: strict ? `line ${at} is not valid JSON` : "line is not valid JSON" };
    }
    if (strict && (typeof evt !== "object" || evt === null || !validateEvent(evt))) {
      return { corrupt: `line ${at} is not a valid ledger event` };
    }
    events.push(evt);
  }
  return { events };
}
