import { statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Ledger } from "./ledger.ts";
import { runGate } from "./gate.ts";
import { renderReport } from "./report.ts";
import { loadEyeConfig, runFreshEyesPass } from "./fresh-eyes.ts";
import { changesOutsideScope, checkCleanAt, headCommitSync, resolveClaimedCommit } from "./workspace.ts";
import { FactoryError } from "./errors.ts";
import type { AttemptAccepted, ContractSet, GateFinished, LedgerEvent, Verdict } from "./events.ts";
import type { GateResult } from "./gate.ts";

/** Task ids become report filenames, so they stay flat and filename-safe. */
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface FactoryOptions {
  /** Directory for `ledger.jsonl`, `report-<task>-<n>.md` and `gate-<task>-<n>.log` files. */
  stateDir: string;
  /** Gate timeout override (ms). Defaults to DEFAULT_GATE_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Fresh-eyes total budget override (ms), both tries together. Defaults to EYE_TOTAL_BUDGET_MS. */
  eyeBudgetMs?: number;
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
  /**
   * Marks the fresh-eyes pass ON for this task (ADR 0005: off unless marked).
   * The eye's model and key are plugin-level config (`<stateDir>/eye.json`),
   * never Contract fields.
   */
  freshEyes?: true;
}

export interface ClaimInput {
  task: string;
  sha: string;
  /** Who claimed, when the caller knows it — recorded on `claim_reported` (ticket 02b). */
  agent?: string;
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
  /**
   * The live Contract whose workspace contains `cwd`, if any — the choke's
   * mechanical "contracted agent" test (v0.0.4 map decision 5: asks from
   * agents without a live Contract are not the factory's business). Live =
   * contract set and no accepted Attempt yet. When several live Contracts
   * cover the same tree, the latest in ledger order wins.
   */
  liveContractFor(cwd: string): ContractSet | undefined;
  /**
   * The task's Contract — the one lookup every asker of a task's history
   * needs (a Claim verifying its gate, a synthetic ask binding its cwd).
   * Undefined when no Contract was ever set for the task.
   */
  contractFor(task: string): ContractSet | undefined;
}

export function createFactory(options: FactoryOptions): Factory {
  const { stateDir } = options;
  const ledger = Ledger.open(join(stateDir, "ledger.jsonl"));
  const recoveredAttempts = recoverInterruptedAttempts(ledger, stateDir);

  return {
    ledger,
    stateDir,
    recoveredAttempts,

    setContract({ task, workspace, gate, artifact, scope, freshEyes }) {
      assertTaskId(task);
      if (gate.trim() === "") throw new FactoryError("invalid-contract", "gate command must be a non-empty string");
      if (artifact.trim() === "") throw new FactoryError("invalid-contract", "artifact path must be a non-empty string");
      if (freshEyes !== undefined && freshEyes !== true) {
        throw new FactoryError("invalid-contract", "freshEyes marks the pass ON — omit it, or set it to exactly true");
      }
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
      }
      // The base commit is recorded on every Contract since v0.0.2 (ticket 03
      // R2): it is the diff range for the scope check and the fresh-eyes pass.
      const base = headCommitSync(workspace);
      if (base === undefined) {
        throw new FactoryError(
          "invalid-contract",
          "the workspace must be a git workspace with a resolvable HEAD — the Contract's base commit is the diff base for the scope check and the fresh-eyes pass",
        );
      }
      // Fresh-eyes fails fast here: marking a Contract without a usable eye
      // must error before any Agent work starts, not 60s into a green claim
      // (ticket 04 §3).
      if (freshEyes === true) {
        const eye = loadEyeConfig(stateDir);
        if (!eye.ok) {
          throw new FactoryError("eye-unconfigured", `fresh-eyes is on, but the eye is not usable: ${eye.reason}`);
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
        ...(scope === undefined || scope.length === 0 ? {} : { scope }),
        base,
        ...(freshEyes === undefined ? {} : { freshEyes }),
      });
    },

    async claim({ task, sha, agent }) {
      assertTaskId(task);
      const contract = this.contractFor(task);
      if (!contract) throw new FactoryError("unknown-task", `no contract set for task ${task} — register one first`);
      const history = ledger.eventsFor(task);

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

      ledger.append({
        event: "claim_reported",
        task,
        attempt,
        sha,
        ...(agent === undefined || agent.trim() === "" ? {} : { agent }),
      });
      ledger.append({ event: "gate_started", task, attempt, cmd: contract.gate });

      // Station 1 — the claimed commit must exist as one full object. An empty,
      // unknown or ambiguous sha is a red Verdict (ADR 0002), and the gate
      // command never runs on an unverified tree.
      const resolved = await resolveClaimedCommit(contract.workspace, sha);
      if (!resolved.ok) {
        return finish(task, attempt, ledger, stateDir, contract, { exit: null, verdict: "red", note: resolved.reason, timedOut: false }, undefined);
      }

      // Station 2 — clean tree, HEAD at the claimed commit, before the gate.
      const before = await checkCleanAt(contract.workspace, resolved.full);
      if (!before.ok) {
        return finish(
          task,
          attempt,
          ledger,
          stateDir,
          contract,
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
          contract,
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
            contract,
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
            contract,
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

      return finish(task, attempt, ledger, stateDir, contract, result, resolved.full, options.eyeBudgetMs);
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
      const events = attemptEvents(history, attempt);
      if (events.length === 0) {
        throw new FactoryError("unknown-attempt", `task ${task} has no attempt ${attempt}`);
      }
      const priorAccept = history.findLast((e): e is AttemptAccepted => e.event === "attempt_accepted");
      if (priorAccept) {
        throw new FactoryError(
          "already-accepted",
          `task ${task} was already accepted at attempt ${priorAccept.attempt}; the ledger is append-only`,
        );
      }
      const gate = events.findLast((e): e is GateFinished => e.event === "gate_finished");
      if (!gate || gate.verdict !== "green") {
        throw new FactoryError(
          "not-green",
          `attempt ${attempt} of task ${task} has no green verdict — the Owner accepts evidence, and there is none`,
        );
      }
      return ledger.append({ event: "attempt_accepted", task, attempt });
    },

    liveContractFor(cwd) {
      const accepted = new Set<string>();
      for (const evt of ledger.events) {
        if (evt.event === "attempt_accepted") accepted.add(evt.task);
      }
      let match: ContractSet | undefined;
      for (const evt of ledger.events) {
        if (evt.event === "contract_set" && !accepted.has(evt.task) && covers(evt, cwd)) match = evt;
      }
      return match;
    },

    contractFor(task) {
      return ledger.eventsFor(task).findLast((e): e is ContractSet => e.event === "contract_set");
    },
  };
}

/** A Contract covers a cwd when the cwd is the workspace or sits inside it. */
function covers(contract: ContractSet, cwd: string): boolean {
  return cwd === contract.workspace || cwd.startsWith(`${contract.workspace}/`);
}

/**
 * Every Attempt's closing window: the full gate output lands beside the report
 * (ticket 02a), the Verdict is appended with a pointer to it, and — when the
 * Contract marks fresh-eyes and the Verdict is green — the eye's one advisory
 * pass runs before the report, so the report is written once, already
 * containing the eye's line (ticket 03 §2).
 */
async function finish(
  task: string,
  attempt: number,
  ledger: Ledger,
  stateDir: string,
  contract: ContractSet,
  result: GateResult,
  sha: string | undefined,
  eyeBudgetMs?: number,
): Promise<ClaimOutcome> {
  let outputPath: string | undefined;
  if (result.output !== undefined) {
    outputPath = join(stateDir, `gate-${task}-${attempt}.log`);
    writeFileSync(outputPath, result.output);
  }
  const gate = ledger.append({
    event: "gate_finished",
    task,
    attempt,
    exit: result.exit,
    verdict: result.verdict,
    note: result.note,
    ...(sha === undefined ? {} : { sha }),
    ...(outputPath === undefined ? {} : { outputPath }),
  });
  if (contract.freshEyes === true && result.verdict === "green" && sha !== undefined) {
    const eye = await runFreshEyesPass({ stateDir, contract, claimedSha: sha, gateOutputPath: outputPath, budgetMs: eyeBudgetMs });
    ledger.append({
      event: "fresh_eyes_written",
      task,
      attempt,
      model: eye.model,
      outcome: eye.outcome,
      finding: eye.finding,
      durationMs: eye.durationMs,
    });
  }
  const reportPath = writeAttemptReport(task, attempt, ledger, stateDir);
  return { attempt, verdict: result.verdict, gate, reportPath };
}

/** Every Attempt ends the same way: report rendered from the ledger, written, acknowledged. */
function writeAttemptReport(task: string, attempt: number, ledger: Ledger, stateDir: string): string {
  const markdown = renderReport(task, attempt, ledger.eventsFor(task));
  const reportPath = join(stateDir, `report-${task}-${attempt}.md`);
  writeFileSync(reportPath, markdown);
  ledger.append({ event: "report_written", task, attempt, path: reportPath });
  return reportPath;
}

/** The highest Attempt number a task's history mentions, or 0 when none opened yet. */
function maxAttempt(history: readonly LedgerEvent[]): number {
  let max = 0;
  for (const evt of history) {
    if ("attempt" in evt && evt.attempt > max) max = evt.attempt;
  }
  return max;
}

/** One Attempt's own events — Contracts and choke events belong to the Task, not to any Attempt. */
function attemptEvents(history: readonly LedgerEvent[], attempt: number): LedgerEvent[] {
  return history.filter((e) => "attempt" in e && e.attempt === attempt);
}

/**
 * An Attempt is open while its report is not written. Between gate_started and
 * report_written there are two awaits — the gate and, on a green fresh-eyes
 * Contract, the eye's pass — so an open Attempt usually means one of them is
 * running.
 */
function attemptIsOpen(history: readonly LedgerEvent[], attempt: number): boolean {
  const events = attemptEvents(history, attempt);
  return events.length > 0 && !events.some((e) => e.event === "report_written");
}

/**
 * ADR 0003 recovery, run once when the factory opens its ledger: any Attempt
 * that never reached its report gets one now. An Attempt with no gate_finished
 * was interrupted before any green was established — red is the fact, not a
 * guess. An Attempt that already has its gate_finished (a restart during the
 * fresh-eyes pass is the one window where that happens) gets only its missing
 * report — never a second gate_finished over a verdict that already landed
 * (ticket 03 R1).
 */
function recoverInterruptedAttempts(ledger: Ledger, stateDir: string): { task: string; attempt: number }[] {
  const recovered: { task: string; attempt: number }[] = [];
  const tasks = [...new Set(ledger.events.map((e) => e.task).filter((task): task is string => typeof task === "string"))];
  for (const task of tasks) {
    const history = ledger.eventsFor(task);
    for (let attempt = 1; attempt <= maxAttempt(history); attempt++) {
      if (!attemptIsOpen(history, attempt)) continue;
      const events = attemptEvents(history, attempt);
      const gateStarted = events.some((e) => e.event === "gate_started");
      const alreadyFinished = events.some((e) => e.event === "gate_finished");
      if (!alreadyFinished) {
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
      }
      writeAttemptReport(task, attempt, ledger, stateDir);
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
