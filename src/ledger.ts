import { appendFileSync, closeSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { FactoryError } from "./errors.ts";
import { EVENT_NAMES } from "./events.ts";
import type { LedgerEvent, PendingEvent } from "./events.ts";

/**
 * Append-only JSONL ledger. Lines are never mutated or rewritten — the file is
 * the audit trail; `events` is just the read-back view of it.
 *
 * One instance per file per process: two `open` calls on the same path keep
 * independent seq counters and would collide. The v0.0.1 shell holds exactly
 * one factory (and therefore one ledger) per daemon.
 *
 * `append` stamps every event with `ts` (ISO 8601 UTC, ADR 0003) and returns
 * only after the line *and* its `\n` are fsynced. That promise is what makes
 * the one recovery we allow honest: a last line with no trailing newline was
 * never acknowledged to anyone, so on open it is moved to
 * `<path>.quarantine` and dropped (ADR 0003). Any other damage still refuses
 * to open.
 */
export class Ledger {
  readonly #path: string;
  readonly #events: LedgerEvent[] = [];
  #nextSeq: number;

  private constructor(path: string, events: readonly LedgerEvent[]) {
    this.#path = path;
    this.#events.push(...events);
    this.#nextSeq = (events.at(-1)?.seq ?? 0) + 1;
  }

  /** Loads and validates an existing ledger, or starts a fresh one at seq 1. */
  static open(path: string): Ledger {
    mkdirSync(dirname(path), { recursive: true });
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") raw = "";
      else throw err;
    }

    if (raw !== "" && !raw.endsWith("\n")) {
      raw = quarantineUnterminatedTail(path, raw);
    }

    const events: LedgerEvent[] = [];
    if (raw !== "") {
      const lines = raw.split("\n");
      let prevSeq = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (line === "") {
          if (i === lines.length - 1) break; // trailing newline after the last event is fine
          throw new FactoryError("corrupted-ledger", `blank line at line ${i + 1} of ${path}`);
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          throw new FactoryError("corrupted-ledger", `line ${i + 1} of ${path} is not valid JSON: ${line.slice(0, 80)}`);
        }
        const evt = parsed as LedgerEvent;
        const valid =
          typeof evt === "object" &&
          evt !== null &&
          typeof (evt as { seq?: unknown }).seq === "number" &&
          Number.isInteger((evt as { seq: number }).seq) &&
          (evt as { seq: number }).seq > prevSeq &&
          typeof (evt as { event?: unknown }).event === "string" &&
          (EVENT_NAMES as readonly string[]).includes((evt as { event: string }).event) &&
          typeof (evt as { ts?: unknown }).ts === "string" &&
          shapeIsValid(evt);
        if (!valid) {
          throw new FactoryError("corrupted-ledger", `line ${i + 1} of ${path} is not a valid ledger event`);
        }
        prevSeq = (evt as { seq: number }).seq;
        events.push(evt);
      }
    }
    return new Ledger(path, events);
  }

  /** Assigns the next seq, stamps `ts`, appends one JSONL line, fsyncs, and returns the event. */
  append<T extends PendingEvent>(evt: T): T & { seq: number; ts: string } {
    const record = { seq: this.#nextSeq, ts: new Date().toISOString(), ...evt } as T & { seq: number; ts: string };
    const line = `${JSON.stringify(record)}\n`;
    // O_APPEND + a single write makes the line land atomically at EOF; fsync
    // puts it on disk before append returns. Sync I/O also keeps seq assignment
    // and the write atomic within one JS turn.
    const fd = openSync(this.#path, "a");
    try {
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.#events.push(record as LedgerEvent);
    this.#nextSeq += 1;
    return record;
  }

  get path(): string {
    return this.#path;
  }

  get events(): readonly LedgerEvent[] {
    return this.#events;
  }

  eventsFor(task: string): LedgerEvent[] {
    return this.#events.filter((e) => e.task === task);
  }
}

/**
 * Per-event required shape. The attempt-scoped loop (ADR 0003) carries a
 * positive-integer Attempt on every post-Contract event; the v0.0.4 choke
 * events carry none — permit events need their task and agent, `git_blocked`
 * needs its command/rule/cwd/blockId and may lack a task entirely (the shim
 * refuses no matter who runs it, bindable or not). The v0.0.5 spawn events
 * carry none either — they precede any attempt — and need their task,
 * provider, arity, and (for a refusal) rule and reason.
 */
function shapeIsValid(evt: LedgerEvent): boolean {
  const asRecord = evt as unknown as Record<string, unknown>;
  const taskIsString = typeof asRecord.task === "string";
  if (evt.event === "contract_set") return taskIsString;
  if (evt.event === "permit_allowed" || evt.event === "permit_denied") {
    return taskIsString && typeof asRecord.agent === "string" && (evt.event === "permit_allowed" || typeof asRecord.rule === "string");
  }
  if (evt.event === "git_blocked") {
    return (
      (asRecord.task === undefined || taskIsString) &&
      (asRecord.agent === undefined || typeof asRecord.agent === "string") &&
      typeof asRecord.command === "string" &&
      typeof asRecord.rule === "string" &&
      typeof asRecord.cwd === "string" &&
      typeof asRecord.blockId === "string"
    );
  }
  if (evt.event === "spawn_dispatched" || evt.event === "spawn_refused") {
    return (
      taskIsString &&
      typeof asRecord.provider === "string" &&
      typeof asRecord.arity === "number" &&
      Number.isInteger(asRecord.arity) &&
      asRecord.arity >= 1 &&
      (evt.event === "spawn_dispatched" || (typeof asRecord.rule === "string" && typeof asRecord.reason === "string"))
    );
  }
  const attempt = asRecord.attempt;
  return taskIsString && typeof attempt === "number" && Number.isInteger(attempt) && attempt >= 1;
}

/**
 * Moves the unterminated tail of the ledger file to `<path>.quarantine` and
 * truncates the ledger to its last complete line. Returns the surviving
 * content. The quarantined bytes are kept verbatim for inspection — nothing is
 * silently lost, and nothing half-written is trusted.
 */
function quarantineUnterminatedTail(path: string, raw: string): string {
  const lastNewline = raw.lastIndexOf("\n");
  const complete = lastNewline === -1 ? "" : raw.slice(0, lastNewline + 1);
  const tail = raw.slice(lastNewline + 1);
  appendFileSync(`${path}.quarantine`, `${tail}\n`);
  const fd = openSync(path, "r+");
  try {
    writeSync(fd, complete);
    ftruncateSync(fd, Buffer.byteLength(complete));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return complete;
}
