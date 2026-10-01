import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { FactoryError } from "./errors.ts";
import type { LedgerEvent, PendingEvent } from "./events.ts";

const EVENT_NAMES: ReadonlySet<string> = new Set([
  "contract_set",
  "done_reported",
  "gate_started",
  "gate_finished",
  "report_written",
]);

/**
 * Append-only JSONL ledger. Lines are never mutated or rewritten — the file is
 * the audit trail; `events` is just the read-back view of it.
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
          Number.isInteger((evt as { seq?: unknown }).seq) &&
          (evt as { seq: number }).seq > prevSeq &&
          typeof (evt as { event?: unknown }).event === "string" &&
          EVENT_NAMES.has((evt as { event: string }).event) &&
          typeof (evt as { task?: unknown }).task === "string";
        if (!valid) {
          throw new FactoryError("corrupted-ledger", `line ${i + 1} of ${path} is not a valid ledger event`);
        }
        prevSeq = (evt as { seq: number }).seq;
        events.push(evt);
      }
    }
    return new Ledger(path, events);
  }

  /** Assigns the next seq, appends one JSONL line, fsyncs, and returns the event. */
  append<T extends PendingEvent>(evt: T): T & { seq: number } {
    const record = { seq: this.#nextSeq, ...evt } as T & { seq: number };
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
