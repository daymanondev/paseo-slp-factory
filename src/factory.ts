import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "./ledger.ts";
import { runGate } from "./gate.ts";
import { renderReport } from "./report.ts";
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
}

export interface DoneInput {
  task: string;
  sha: string;
}

export interface DoneOutcome {
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
  /** Records the agent's claim, runs the gate on it, writes the report. */
  reportDone(input: DoneInput): Promise<DoneOutcome>;
}

export function createFactory(options: FactoryOptions): Factory {
  const { stateDir } = options;
  const workspace = options.workspace ?? process.cwd();
  const ledger = Ledger.open(join(stateDir, "ledger.jsonl"));

  return {
    ledger,
    stateDir,
    workspace,

    setContract({ task, gate, artifact }) {
      assertTaskId(task);
      if (gate.trim() === "") throw new FactoryError("invalid-contract", "gate command must be a non-empty string");
      if (artifact.trim() === "") throw new FactoryError("invalid-contract", "artifact path must be a non-empty string");
      const existing = ledger.eventsFor(task).some((e) => e.event === "contract_set");
      if (existing) {
        throw new FactoryError(
          "contract-exists",
          `contract already set for task ${task}; the ledger is append-only — use a new task id`,
        );
      }
      return ledger.append({ event: "contract_set", task, gate, artifact });
    },

    async reportDone({ task, sha }) {
      assertTaskId(task);
      if (sha.trim() === "") throw new FactoryError("invalid-done", "sha must be a non-empty string");
      const contract = ledger.eventsFor(task).findLast((e) => e.event === "contract_set");
      if (!contract) throw new FactoryError("unknown-task", `no contract set for task ${task} — register one first`);

      ledger.append({ event: "done_reported", task, sha });
      ledger.append({ event: "gate_started", task, cmd: contract.gate });
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
      const gate = ledger.append({
        event: "gate_finished",
        task,
        exit: result.exit,
        verdict: result.verdict,
        note: result.note,
      });

      const markdown = renderReport(task, ledger.eventsFor(task));
      const reportPath = join(stateDir, `report-${task}.md`);
      writeFileSync(reportPath, markdown);
      ledger.append({ event: "report_written", task, path: reportPath });

      return { verdict: result.verdict, gate, reportPath };
    },
  };
}

function assertTaskId(task: string): void {
  if (!TASK_ID_PATTERN.test(task)) {
    throw new FactoryError(
      "invalid-task",
      `task id "${task}" is invalid — use letters, digits, ".", "_", "-" (it becomes a report filename)`,
    );
  }
}
