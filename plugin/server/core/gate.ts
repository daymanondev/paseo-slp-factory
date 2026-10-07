import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { DEFAULT_GATE_TIMEOUT_MS, REPORT_NOTE_MAX_CHARS, STDOUT_TAIL_CAP_BYTES } from "./constants.ts";
import type { Verdict } from "./events.ts";

export interface GateInput {
  /** Shell command from the contract, e.g. `npm test`. Run through /bin/sh. */
  cmd: string;
  /** Task workspace — the command's cwd and the base for the artifact path. */
  cwd: string;
  /** Required artifact path (relative to cwd). Its existence is part of a green verdict. */
  artifact?: string | undefined;
  /** Kill + red after this long. Defaults to DEFAULT_GATE_TIMEOUT_MS. */
  timeoutMs?: number | undefined;
}

export interface GateResult {
  exit: number | null;
  verdict: Verdict;
  note: string;
  timedOut: boolean;
}

/**
 * Runs the contract's gate command and returns the facts: exit code, a capped
 * one-line note from the output tail, and the verdict. The verdict is green
 * only when the command exits 0 AND the contract's artifact exists.
 *
 * Timeout policy is deliberately minimal for v0.0.1: kill the process group
 * and record red. Hardening (per-run budgets, output files) is later work.
 */
export function runGate(input: GateInput): Promise<GateResult> {
  const { cmd, cwd, artifact } = input;
  const timeoutMs = input.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let outTail = "";
    let errTail = "";
    let timedOut = false;
    let settled = false;

    // detached: true makes the shell a process-group leader so a timeout can
    // kill the whole tree (npm spawns children), not just the shell.
    // NODE_TEST_CONTEXT must not leak: it switches a nested `node --test`
    // gate into silent child mode (0 tests, exit 0 — a false green).
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(cmd, { shell: true, cwd, detached: true, env, stdio: ["ignore", "pipe", "pipe"] });

    const keepTail = (prev: string, chunk: Buffer): string => (prev + chunk.toString("utf8")).slice(-STDOUT_TAIL_CAP_BYTES);
    child.stdout.on("data", (chunk: Buffer) => {
      outTail = keepTail(outTail, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errTail = keepTail(errTail, chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, timeoutMs);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (timedOut) {
        resolve({ exit: null, verdict: "red", note: `gate killed after ${timeoutMs}ms (timeout)`, timedOut: true });
        return;
      }

      const outputNote = squashNote(outTail) || squashNote(errTail);
      if (artifact !== undefined && !existsSync(resolvePath(cwd, artifact))) {
        const missingNote = `artifact "${artifact}" not found`;
        resolve({
          exit: code,
          verdict: "red",
          note: code === 0 ? missingNote : outputNote || missingNote,
          timedOut: false,
        });
        return;
      }

      const verdict: Verdict = code === 0 ? "green" : "red";
      const note = code === null && outputNote === "" ? "killed by signal" : outputNote;
      resolve({ exit: code, verdict, note, timedOut: false });
    });
  });
}

function killGroup(child: import("node:child_process").ChildProcess): void {
  if (child.pid === undefined || process.platform === "win32") {
    child.kill("SIGKILL");
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/** Collapse the tail to one line, capped to its final characters — test summaries live at the end. */
function squashNote(tail: string): string {
  return tail.replace(/\s+/g, " ").trim().slice(-REPORT_NOTE_MAX_CHARS);
}
