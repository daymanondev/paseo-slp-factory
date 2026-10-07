/**
 * paseo-factory plugin server entry — the shell around the pure core.
 *
 * The plugin process owns the whole loop (ADR 0004): it opens the ledger once
 * at boot (recovering interrupted attempts per ADR 0003), keeps the factory
 * instance for its lifetime as the single Ledger writer and Gate runner, and
 * serves the spool that the CLIs submit through. It also puts the Claim CLI
 * on every agent's PATH. The Owner reaches the same loop through
 * `plugin/bin/factory.mjs` (`contract`, `accept`), which is never on an agent
 * PATH.
 */
import { homedir } from "node:os";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createFactory } from "./server/core/factory.ts";
import { PLUGIN_ID, pluginDirFor, resolvePaseoHome, stateDirFor } from "./server/paths.ts";
import { claimCliBinDir, ensureClaimCli, injectClaimCliPath } from "./server/shell.ts";
import { spoolRootFor, startSpool } from "./server/spool.ts";

const SHELL_VERSION = "0.0.1";

const log = (message: string) => console.log(`[${PLUGIN_ID}] ${message}`);

export default function contribute(server: PluginServerContext) {
  const home = resolvePaseoHome(process.env, homedir());
  const stateDir = stateDirFor(home);
  const pluginDir = pluginDirFor(home);

  // Opening validates any existing ledger (fail closed — a corrupt ledger
  // fails the plugin loudly) and closes attempts interrupted by a previous
  // lifetime: red, reported, and logged, never silently dropped (ADR 0003).
  const factory = createFactory({ stateDir });
  for (const { task, attempt } of factory.recoveredAttempts) {
    log(`recovered on open: attempt ${attempt} of ${task} closed red — interrupted by a restart`);
  }

  if (pluginDir === undefined) {
    log(`up v${SHELL_VERSION} — WARNING: plugin directory not recorded in ${home}/config.json; ` +
      `factory-claim cannot be put on agent PATHs until the plugin is installed from a directory`);
  } else {
    ensureClaimCli(stateDir, pluginDir, process.execPath);
    log(`up v${SHELL_VERSION} — state ${stateDir}, plugin ${pluginDir}, claim CLI ${claimCliBinDir(stateDir)}`);
  }

  const spool = startSpool(stateDir, factory, { onLog: log });
  log(`spool listening on ${spoolRootFor(stateDir)}/{requests,replies,processed}`);

  const offSessionOpen = server.before("agent.session_open", ({ request }) => {
    if (pluginDir === undefined) return undefined;
    const next = injectClaimCliPath(request, claimCliBinDir(stateDir));
    if (next !== request) {
      log(`factory-claim on PATH for agent ${request.agentId} (${request.reason})`);
    }
    return next;
  });

  return () => {
    offSessionOpen();
    spool.stop();
    log(`down v${SHELL_VERSION}`);
  };
}
