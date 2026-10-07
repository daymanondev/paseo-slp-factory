import { statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Ledger } from "./ledger.ts";
import { runGate } from "./gate.ts";
import { renderReport } from "./report.ts";
import { changesOutsideScope, checkCleanAt, headCommitSync, resolveClaimedCommit } from "./workspace.ts";
import { FactoryError } from "./errors.ts";
import type { AttemptAccepted, ContractSet, GateFinished, LedgerEvent, Verdict } from "./events.ts";
import type { GateResult } from "./gate.ts";

/** Task ids become report filenames, so they stay flat and filename-safe. */
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface FactoryOptions {
  /** Directory for `ledger.jsonl` and `report-<task>-<n>.md` files. */
  stateDir: string;
  /** Gate timeout override (ms). Defaults to DEFAULT_GATE_TIMEOUT_MS. */
  timeoutMs?: number;
}

export interface ContractInput {
  task: string;
  /**
   * The Workspace this Task's work lives in — absolute path, chosen by the
   * Owner and fixed from here on (ADR 0002 / ticket 08): the Gate's cwd and
   * the base for the artifact and scope. The Agent never gets to pick a cwd.
   */
  workspace: string;
  gate: string;
  artifact: string;
  /**
   * Path prefixes (workspace-relative) the task may touch — the mechanical
   * task boundary (ticket 14). Omitted or empty = unrestricted, v0.0.1
   * behavior. A diff outside the scope is a red Verdict naming the files.
   */
  scope?: string[];
}

export interface ClaimInput {
  task: string;
  sha: string;
}

export interface ClaimOutcome {
  /** The Attempt this Claim opened — attempts are numbered per task from 1. */
  attempt: number;
  verdict: Verdict;
  gate: GateFinished;
  reportPath: string;
}

export interface AcceptInput {
  task: string;
  attempt: number;
}

export interface Factory {
  readonly ledger: Ledger;
  readonly stateDir: string;
  /** Attempts the factory closed red while opening (ADR 0003 recovery) — for the shell to log loudly. */
  readonly recoveredAttempts: readonly { task: string; attempt: number }[];
  /** Registers a task's done-criteria. One contract per task — the ledger is append-only. */
  setContract(input: ContractInput): ContractSet;
  /**
   * Records the Agent's Claim, verifies it against the Workspace, runs the gate
   * on it, writes the report. Per ADR 0002 the Verdict attests the claimed
   * commit: the sha is resolved, and the tree must sit clean with HEAD at that
   * commit both before and after the gate. Anything else is red, never a
   * fallback to whatever is on disk. Each Call opens the task's next Attempt;
   * a Claim while the previous Attempt is still open is rejected (ADR 0003).
   */
  claim(input: ClaimInput): Promise<ClaimOutcome>;
  /**
   * The Owner accepts one green Attempt (ADR 0002). Green is necessary, not
   * sufficient — this is the only acceptance act in the factory, and it is
   * never the Agent's.
   */
  accept(input: AcceptInput): AttemptAccepted;
}

export function createFactory(options: FactoryOptions): Factory {
  const { stateDir } = options;
  const ledger = Ledger.open(join(stateDir, "ledger.jsonl"));
  const recoveredAttempts = recoverInterruptedAttempts(ledger, stateDir);

  return {
    ledger,
    stateDir,
    recoveredAttempts,

    setContract({ task, workspace, gate, artifact, scope }) {
      assertTaskId(task);
      if (gate.trim() === "") throw new FactoryError("invalid-contract", "gate command must be a non-empty string");
      if (artifact.trim() === "") throw new FactoryError("invalid-contract", "artifact path must be a non-empty string");
      if (!isAbsolute(workspace)) {
        throw new FactoryError("invalid-contract", `workspace "${workspace}" must be an absolute path`);
      }
      let isDirectory = false;
      try {
        isDirectory = statSync(workspace).isDirectory();
      } catch {
        // stays false — the message below is the answer either way
      }
      if (!isDirectory) {
        throw new FactoryError("invalid-contract", `workspace "${workspace}" must be an existing directory`);
      }
      let base: string | undefined;
      if (scope !== undefined && scope.length > 0) {
        const unusable =
          !Array.isArray(scope) ||
          scope.some(
            (prefix) =>
              typeof prefix !== "string" ||
              prefix.trim() === "" ||
              prefix.startsWith("/") ||
              prefix.split("/").includes(".."),
          );
        if (unusable) {
          throw new FactoryError("invalid-contract", "scope must be an array of workspace-relative path prefixes");
        }
        base = headCommitSync(workspace);
        if (base === undefined) {
          throw new FactoryError("invalid-contract", "a scoped contract requires a git workspace with a resolvable HEAD");
        }
      }
      const existing = ledger.eventsFor(task).some((e) => e.event === "contract_set");
      if (existing) {
        throw new FactoryError(
          "contract-exists",
          `contract already set for task ${task}; the ledger is append-only — use a new task id`,
        );
      }
      return ledger.append({
        event: "contract_set",
        task,
        workspace,
        gate,
        artifact,
        ...(base === undefined ? {} : { scope: scope as string[], base }),
      });
    },

    async claim({ task, sha }) {
      assertTaskId(task);
      const history = ledger.eventsFor(task);
      const contract = history.findLast((e): e is ContractSet => e.event === "contract_set");
      if (!contract) throw new FactoryError("unknown-task", `no contract set for task ${task} — register one first`);

      // ADR 0003: Attempts never overlap. The previous one must have reached
      // its report before a new Claim opens the next Attempt.
      const lastAttempt = maxAttempt(history);
      if (lastAttempt > 0 && attemptIsOpen(history, lastAttempt)) {
        throw new FactoryError(
          "gate-running",
          `attempt ${lastAttempt} of task ${task} is still open — wait for its verdict before claiming again`,
        );
      }
      const attempt = lastAttempt + 1;

      ledger.append({ event: "claim_reported", task, attempt, sha });
      ledger.append({ event: "gate_started", task, attempt, cmd: contract.gate });

      // Station 1 — the claimed commit must exist as one full object. An empty,
      // unknown or ambiguous sha is a red Verdict (ADR 0002), and the gate
      // command never runs on an unverified tree.
      const resolved = await resolveClaimedCommit(contract.workspace, sha);
      if (!resolved.ok) {
        return finish(
          task,
          attempt,
          ledger,
          stateDir,
          { exit: null, verdict: "red", note: resolved.reason, timedOut: false },
          undefined,
        );
      }

      // Station 2 — clean tree, HEAD at the claimed commit, before the gate.
      const before = await checkCleanAt(contract.workspace, resolved.full);
      if (!before.ok) {
        return finish(
          task,
          attempt,
          ledger,
          stateDir,
          {
            exit: null,
            verdict: "red",
            note: `workspace not clean at the claimed commit before the gate: ${before.reason}`,
            timedOut: false,
          },
          resolved.full,
        );
      }

      let result: GateResult;
      try {
        result = await runGate({
          cmd: contract.gate,
          cwd: contract.workspace,
          artifact: contract.artifact,
          timeoutMs: options.timeoutMs,
        });
      } catch (err) {
        // A gate that cannot even start is a red fact, not an aborted sequence —
        // the ledger must still reach gate_finished.
        result = {
          exit: null,
          verdict: "red",
          note: `gate failed to start: ${err instanceof Error ? err.message : String(err)}`,
          timedOut: false,
        };
      }

      // Station 3 — same check after the gate: a green exit on a tree that moved
      // during the run attests nothing.
      const after = await checkCleanAt(contract.workspace, resolved.full);
      if (!after.ok) {
        return finish(
          task,
          attempt,
          ledger,
          stateDir,
          {
            exit: result.exit,
            verdict: "red",
            note: `workspace moved during the gate: ${after.reason}`,
            timedOut: false,
          },
          resolved.full,
        );
      }

      // Station 4 — the mechanical task boundary (ticket 14): every file the
      // diff touches must fall inside a declared scope prefix. A task that
      // overreaches is refused here, never prompted back to polite behavior.
      if (contract.scope !== undefined && contract.scope.length > 0) {
        if (contract.base === undefined) {
          return finish(
            task,
            attempt,
            ledger,
            stateDir,
            { exit: result.exit, verdict: "red", note: "scoped contract has no recorded base commit", timedOut: false },
            resolved.full,
          );
        }
        const scopeCheck = await changesOutsideScope(contract.workspace, contract.base, resolved.full, contract.scope);
        if (!scopeCheck.ok) {
          return finish(
            task,
            attempt,
            ledger,
            stateDir,
            {
              exit: result.exit,
              verdict: "red",
              note:
                scopeCheck.reason !== undefined
                  ? `scope check failed: ${scopeCheck.reason}`
                  : `changes outside declared scope: ${scopeCheck.files.join(", ")}`,
              timedOut: false,
            },
            resolved.full,
          );
        }
      }

      return finish(task, attempt, ledger, stateDir, result, resolved.full);
    },

    accept({ task, attempt }) {
      assertTaskId(task);
      if (!Number.isInteger(attempt) || attempt < 1) {
        throw new FactoryError("invalid-attempt", `attempt must be a positive integer, got ${attempt}`);
      }
      const history = ledger.eventsFor(task);
      if (!history.some((e) => e.event === "contract_set")) {
        throw new FactoryError("unknown-task", `no contract set for task ${task} — register one first`);
      }
      const attemptEvents = history.filter((e) => e.event !== "contract_set" && e.attempt === attempt);
      if (attemptEvents.length === 0) {
        throw new FactoryError("unknown-attempt", `task ${task} has no attempt ${attempt}`);
      }
      const priorAccept = history.findLast((e): e is AttemptAccepted => e.event === "attempt_accepted");
      if (priorAccept) {
        throw new FactoryError(
          "already-accepted",
          `task ${task} was already accepted at attempt ${priorAccept.attempt}; the ledger is append-only`,
        );
      }
      const gate = attemptEvents.findLast((e): e is GateFinished => e.event === "gate_finished");
      if (!gate || gate.verdict !== "green") {
        throw new FactoryError(
          "not-green",
          `attempt ${attempt} of task ${task} has no green verdict — the Owner accepts evidence, and there is none`,
        );
      }
      return ledger.append({ event: "attempt_accepted", task, attempt });
    },
  };
}

function finish(
  task: string,
  attempt: number,
  ledger: Ledger,
  stateDir: string,
  result: GateResult,
  sha: string | undefined,
): ClaimOutcome {
  const gate = ledger.append({
    event: "gate_finished",
    task,
    attempt,
    exit: result.exit,
    verdict: result.verdict,
    note: result.note,
    ...(sha === undefined ? {} : { sha }),
  });

  const markdown = renderReport(task, attempt, ledger.events);
  const reportPath = join(stateDir, `report-${task}-${attempt}.md`);
  writeFileSync(reportPath, markdown);
  ledger.append({ event: "report_written", task, attempt, path: reportPath });

  return { attempt, verdict: result.verdict, gate, reportPath };
}

/** The highest Attempt number a task's history mentions, or 0 when none opened yet. */
function maxAttempt(history: readonly LedgerEvent[]): number {
  let max = 0;
  for (const evt of history) {
    if (evt.event !== "contract_set" && evt.attempt > max) max = evt.attempt;
  }
  return max;
}

/**
 * An Attempt is open while its report is not written — after gate_finished the
 * report lands in the same synchronous turn, so in practice this means "the
 * gate is running" (the only await between gate_started and report_written).
 */
function attemptIsOpen(history: readonly LedgerEvent[], attempt: number): boolean {
  const attemptEvents = history.filter((e) => e.event !== "contract_set" && e.attempt === attempt);
  return attemptEvents.length > 0 && !attemptEvents.some((e) => e.event === "report_written");
}

/**
 * ADR 0003 recovery, run once when the factory opens its ledger: any Attempt
 * that never reached its report is closed red and reported, because no green
 * was ever established — red is the fact, not a guess. This is what a plugin
 * restart mid-gate looks like in the ledger when the smoke clears.
 */
function recoverInterruptedAttempts(ledger: Ledger, stateDir: string): { task: string; attempt: number }[] {
  const recovered: { task: string; attempt: number }[] = [];
  const tasks = [...new Set(ledger.events.map((e) => e.task))];
  for (const task of tasks) {
    const history = ledger.eventsFor(task);
    for (let attempt = 1; attempt <= maxAttempt(history); attempt++) {
      if (!attemptIsOpen(history, attempt)) continue;
      const attemptEvents = history.filter((e) => e.event !== "contract_set" && e.attempt === attempt);
      const gateStarted = attemptEvents.some((e) => e.event === "gate_started");
      ledger.append({
        event: "gate_finished",
        task,
        attempt,
        exit: null,
        verdict: "red",
        note: gateStarted
          ? "interrupted — the factory restarted before the Gate finished"
          : "interrupted — the factory restarted before the Gate started",
      });
      const markdown = renderReport(task, attempt, ledger.events);
      const reportPath = join(stateDir, `report-${task}-${attempt}.md`);
      writeFileSync(reportPath, markdown);
      ledger.append({ event: "report_written", task, attempt, path: reportPath });
      recovered.push({ task, attempt });
    }
  }
  return recovered;
}

function assertTaskId(task: string): void {
  if (!TASK_ID_PATTERN.test(task)) {
    throw new FactoryError(
      "invalid-task",
      `task id "${task}" is invalid — use letters, digits, ".", "_", "-" (it becomes a report filename)`,
    );
  }
}
