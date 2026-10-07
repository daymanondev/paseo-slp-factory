/**
 * paseo-factory plugin server entry — the shell around the pure core.
 *
 * v0.0.1 scope (ticket 06): prove the plumbing on a 0.10 daemon. This entry
 * boots visibly, resolves the daemon-scoped state root, opens the ledger
 * through the vendored core, puts the Claim CLI on every agent's PATH
 * (ADR 0004), and nothing else. Wiring the loop is ticket 08.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { Ledger } from "./server/core/ledger.ts";
import { PLUGIN_ID, pluginDirFor, resolvePaseoHome, stateDirFor } from "./server/paths.ts";
import { claimCliBinDir, ensureClaimCli, injectClaimCliPath } from "./server/shell.ts";

const SHELL_VERSION = "0.0.1";

const log = (message: string) => console.log(`[${PLUGIN_ID}] ${message}`);

export default function contribute(server: PluginServerContext) {
  const home = resolvePaseoHome(process.env, homedir());
  const stateDir = stateDirFor(home);
  const pluginDir = pluginDirFor(home);

  // Opening validates any existing ledger and fails the plugin on corruption
  // — fail closed, loudly, never silently degrade (no component dies
  // silently). Ticket 08 turns this into the long-lived factory instance.
  Ledger.open(join(stateDir, "ledger.jsonl"));

  if (pluginDir === undefined) {
    log(`up v${SHELL_VERSION} — WARNING: plugin directory not recorded in ${home}/config.json; ` +
      `factory-claim cannot be put on agent PATHs until the plugin is installed from a directory`);
  } else {
    ensureClaimCli(stateDir, pluginDir, process.execPath);
    log(`up v${SHELL_VERSION} — state ${stateDir}, plugin ${pluginDir}, claim CLI ${claimCliBinDir(stateDir)}`);
  }

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
    log(`down v${SHELL_VERSION}`);
  };
}
