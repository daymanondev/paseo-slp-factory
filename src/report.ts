import { FactoryError } from "./errors.ts";
import type { ContractSet, DoneReported, GateFinished, LedgerEvent } from "./events.ts";

/**
 * Renders `report-<task>.md` from ledger events — every content line traces to
 * one: contract line ← contract_set, claim ← done_reported, gate ← gate_finished,
 * conclusion ← the gate verdict. Target shape is roadmap §2.
 */
export function renderReport(task: string, events: readonly LedgerEvent[], now: Date = new Date()): string {
  const mine = events.filter((e) => e.task === task);
  const contract = mine.findLast((e): e is ContractSet => e.event === "contract_set");
  const done = mine.findLast((e): e is DoneReported => e.event === "done_reported");
  const gate = mine.findLast((e): e is GateFinished => e.event === "gate_finished");

  if (!contract || !done || !gate) {
    const missing = [
      contract ? null : "contract_set",
      done ? null : "done_reported",
      gate ? null : "gate_finished",
    ]
      .filter((name): name is string => name !== null)
      .join(", ");
    throw new FactoryError("incomplete-history", `cannot render report for ${task}: missing ${missing}`);
  }

  const lines = [
    `# ${task} — ${formatTimestamp(now)}`,
    `- Contract: \`${contract.gate}\` green · file \`${contract.artifact}\` exists`,
    `- Agent reported done @ ${done.sha}`,
    `- Gate: ${gate.verdict.toUpperCase()} — ${gate.note}`,
    gate.verdict === "green"
      ? "- Conclusion: DONE — contract met (gate green, artifact present)."
      : "- Conclusion: NOT done — send the red gate back to the agent with the reminder: do not make the tests green yourself.",
  ];
  return `${lines.join("\n")}\n`;
}

function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}
