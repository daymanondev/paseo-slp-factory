/**
 * The agent-facing surface: ADR 0004 delivers the Claim as a CLI on the
 * agent's PATH, not as an MCP tool.
 *
 * Mechanism, verified against the 0.10.3 daemon source: the
 * `agent.session_open` before-hook's returned `env` is applied as an overlay
 * on the daemon's environment for every provider launch, and this hook fires
 * for create, resume, refresh and import alike — while `env` set only at
 * `agent.create` is not re-applied on resume. One hook, every launch.
 *
 * The PATH entry points at `<stateDir>/bin`, which holds a generated wrapper
 * (not the plugin's own `bin/`): the wrapper execs the daemon's node binary
 * explicitly, so the CLI works even under desktop-app daemons whose PATH has
 * no `node`.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { PluginSessionOpenRequest } from "@getpaseo/plugin/server";

/** Where the generated `factory-claim` wrapper lives. */
export function claimCliBinDir(stateDir: string): string {
  return join(stateDir, "bin");
}

/**
 * Prepend the factory bin dir to the request's PATH, idempotently. An empty
 * incoming PATH stays empty-tail-free — a trailing delimiter would put the
 * agent's CWD on PATH.
 */
export function injectClaimCliPath<T extends PluginSessionOpenRequest>(request: T, binDir: string): T {
  const existing = typeof request.env?.PATH === "string" ? request.env.PATH : "";
  if (existing.split(delimiter).includes(binDir)) return request;
  const path = existing === "" ? binDir : `${binDir}${delimiter}${existing}`;
  return { ...request, env: { ...request.env, PATH: path } };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * (Re)generate `<stateDir>/bin/factory-claim`. Rewritten when content changes
 * — a daemon update can move the node binary, and the wrapper must follow.
 * Skipped (returning false) when `pluginDir` is unknown; the entry point
 * logs that loudly instead of dying (law #5).
 */
export function ensureClaimCli(stateDir: string, pluginDir: string, nodeBinary: string): boolean {
  const binDir = claimCliBinDir(stateDir);
  mkdirSync(binDir, { recursive: true });
  const target = join(binDir, "factory-claim");
  const script = join(pluginDir, "bin", "factory-claim.mjs");
  const body = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(nodeBinary)} ${shellQuote(script)} "$@"\n`;
  if (existsSync(target) && readFileSync(target, "utf8") === body) return true;
  writeFileSync(target, body);
  chmodSync(target, 0o755);
  return true;
}
