import { FactoryError } from "./errors.ts";
import type { ClaimReported, ContractSet, GateFinished, LedgerEvent } from "./events.ts";

/**
 * Renders `report-<task>.md` from ledger events — every content line traces to
 * one: contract line ← contract_set, claim ← claim_reported, attested commit ←
 * gate_finished.sha, verdict ← the gate verdict. The report states evidence
 * and stops there: green is not acceptance (ADR 0002), so no line concludes
 * "DONE".
 */
export function renderReport(task: string, events: readonly LedgerEvent[], now: Date = new Date()): string {
  const mine = events.filter((e) => e.task === task);
  const contract = mine.findLast((e): e is ContractSet => e.event === "contract_set");
  const claim = mine.findLast((e): e is ClaimReported => e.event === "claim_reported");
  const gate = mine.findLast((e): e is GateFinished => e.event === "gate_finished");

  if (!contract || !claim || !gate) {
    const missing = [
      contract ? null : "contract_set",
      claim ? null : "claim_reported",
      gate ? null : "gate_finished",
    ]
      .filter((name): name is string => name !== null)
      .join(", ");
    throw new FactoryError("incomplete-history", `cannot render report for ${task}: missing ${missing}`);
  }

  const lines = [
    `# ${task} — ${formatTimestamp(now)}`,
    `- Contract: \`${contract.gate}\` green · file \`${contract.artifact}\` exists${
      contract.scope === undefined ? "" : ` · scope: ${contract.scope.map((s) => `\`${s}\``).join(", ")}`
    }`,
    `- Agent claimed @ ${claim.sha}`,
    ...(gate.sha === undefined ? [] : [`- Attested commit: \`${gate.sha}\``]),
    `- Verdict: ${gate.verdict.toUpperCase()} — ${gate.note}`,
    gate.verdict === "green"
      ? "- Evidence, not acceptance: gate exited 0 at the attested commit, artifact present. Only the Owner accepts an Attempt."
      : "- Contract not met — send the gate note back to the agent, with the reminder: do not make the tests green yourself.",
  ];
  return `${lines.join("\n")}\n`;
}

function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}
