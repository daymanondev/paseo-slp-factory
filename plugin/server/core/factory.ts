import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "./ledger.ts";
import { runGate } from "./gate.ts";
import { renderReport } from "./report.ts";
import { changesOutsideScope, checkCleanAt, headCommitSync, resolveClaimedCommit } from "./workspace.ts";
import { FactoryError } from "./errors.ts";
import type { ContractSet, GateFinished, Verdict } from "./events.ts";
import type { GateResult } from "./gate.ts";

/** Task ids become report filenames, so they stay flat and filename-safe. */
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface FactoryOptions {
  /** Directory for `ledger.jsonl` and `report-<task>.md` (the plugin shell will pass the plugin state root). */
  stateDir: string;
  /** Task workspace — gate cwd and artifact base. Defaults to the process cwd. */
  workspace?: string;
  /** Gate timeout override (ms). Defaults to DEFAULT_GATE_TIMEOUT_MS. */
  timeoutMs?: number;
}

export interface ContractInput {
  task: string;
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
  verdict: Verdict;
  gate: GateFinished;
  reportPath: string;
}

export interface Factory {
  readonly ledger: Ledger;
  readonly stateDir: string;
  readonly workspace: string;
  /** Registers a task's done-criteria. One contract per task — the ledger is append-only. */
  setContract(input: ContractInput): ContractSet;
  /**
   * Records the Agent's Claim, verifies it against the Workspace, runs the gate
   * on it, writes the report. Per ADR 0002 the Verdict attests the claimed
   * commit: the sha is resolved, and the tree must sit clean with HEAD at that
   * commit both before and after the gate. Anything else is red, never a
   * fallback to whatever is on disk.
   */
  claim(input: ClaimInput): Promise<ClaimOutcome>;
}

export function createFactory(options: FactoryOptions): Factory {
  const { stateDir } = options;
  const workspace = options.workspace ?? process.cwd();
  const ledger = Ledger.open(join(stateDir, "ledger.jsonl"));

  return {
    ledger,
    stateDir,
    workspace,

    setContract({ task, gate, artifact, scope }) {
      assertTaskId(task);
      if (gate.trim() === "") throw new FactoryError("invalid-contract", "gate command must be a non-empty string");
      if (artifact.trim() === "") throw new FactoryError("invalid-contract", "artifact path must be a non-empty string");
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
        gate,
        artifact,
        ...(base === undefined ? {} : { scope: scope as string[], base }),
      });
    },

    async claim({ task, sha }) {
      assertTaskId(task);
      const contract = ledger.eventsFor(task).findLast((e) => e.event === "contract_set");
      if (!contract) throw new FactoryError("unknown-task", `no contract set for task ${task} — register one first`);

      ledger.append({ event: "claim_reported", task, sha });
      ledger.append({ event: "gate_started", task, cmd: contract.gate });

      // Station 1 — the claimed commit must exist as one full object. An empty,
      // unknown or ambiguous sha is a red Verdict (ADR 0002), and the gate
      // command never runs on an unverified tree.
      const resolved = await resolveClaimedCommit(workspace, sha);
      if (!resolved.ok) {
        return finish(
          task,
          ledger,
          stateDir,
          { exit: null, verdict: "red", note: resolved.reason, timedOut: false },
          undefined,
        );
      }

      // Station 2 — clean tree, HEAD at the claimed commit, before the gate.
      const before = await checkCleanAt(workspace, resolved.full);
      if (!before.ok) {
        return finish(
          task,
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
          cwd: workspace,
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
      const after = await checkCleanAt(workspace, resolved.full);
      if (!after.ok) {
        return finish(
          task,
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
            ledger,
            stateDir,
            { exit: result.exit, verdict: "red", note: "scoped contract has no recorded base commit", timedOut: false },
            resolved.full,
          );
        }
        const scopeCheck = await changesOutsideScope(workspace, contract.base, resolved.full, contract.scope);
        if (!scopeCheck.ok) {
          return finish(
            task,
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

      return finish(task, ledger, stateDir, result, resolved.full);
    },
  };
}

function finish(
  task: string,
  ledger: Ledger,
  stateDir: string,
  result: GateResult,
  sha: string | undefined,
): ClaimOutcome {
  const gate = ledger.append({
    event: "gate_finished",
    task,
    exit: result.exit,
    verdict: result.verdict,
    note: result.note,
    ...(sha === undefined ? {} : { sha }),
  });

  const markdown = renderReport(task, ledger.eventsFor(task));
  const reportPath = join(stateDir, `report-${task}.md`);
  writeFileSync(reportPath, markdown);
  ledger.append({ event: "report_written", task, path: reportPath });

  return { verdict: result.verdict, gate, reportPath };
}

function assertTaskId(task: string): void {
  if (!TASK_ID_PATTERN.test(task)) {
    throw new FactoryError(
      "invalid-task",
      `task id "${task}" is invalid — use letters, digits, ".", "_", "-" (it becomes a report filename)`,
    );
  }
}
