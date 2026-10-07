#!/usr/bin/env node
/**
 * factory-claim — the Agent's single factory command (ADR 0004).
 *
 * v0.0.1 stub (ticket 06): parses the real argument surface and reports that
 * nothing was submitted. Ticket 08 replaces the body with a spool submit to
 * the plugin; the wrapper that puts this script on agent PATHs execs it with
 * the daemon's node binary, so the shebang only matters for direct dev runs.
 */
import { parseArgs } from "node:util";

const usage = `usage: factory-claim --task <id> --sha <commit-sha>

Claim that the task is finished at a specific commit. The factory does not
trust the claim: it runs the contract's gate at the claimed commit and
records the verdict (paseo-factory v0.0.1).`;

let args;
try {
  args = parseArgs({
    strict: true,
    options: {
      task: { type: "string" },
      sha: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
} catch (err) {
  console.error(`factory-claim: ${err instanceof Error ? err.message : String(err)}\n\n${usage}`);
  process.exit(2);
}

if (args.values.help) {
  console.log(usage);
  process.exit(0);
}

if (typeof args.values.task !== "string" || typeof args.values.sha !== "string") {
  console.error(`factory-claim: --task and --sha are both required\n\n${usage}`);
  process.exit(2);
}

console.log(
  `factory-claim: received task ${args.values.task} at ${args.values.sha}, ` +
    `but the factory loop is not wired yet — nothing was submitted (ticket 08).`,
);
process.exit(1);
