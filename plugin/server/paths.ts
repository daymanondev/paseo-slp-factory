/**
 * Path resolution for the plugin shell.
 *
 * The daemon forks the plugin process without an env override, so the plugin
 * inherits `PASEO_HOME` from the daemon: a daemon started with `--home
 * <custom>` keeps all factory state under that home, never `~/.paseo`
 * (ticket 01, verified against daemon `paseo-home.js`).
 *
 * The compiled plugin bundle is evaluated as CommonJS without `import.meta`
 * or `__dirname`, so the plugin cannot see its own source directory; the
 * daemon records it in `<paseoHome>/config.json` at install time and that is
 * where we read it back from (the same trick seatworks uses).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PLUGIN_ID = "paseo-factory";

/** `~`-expansion so a manually set `PASEO_HOME=~/x` still resolves. */
export function expandHome(value: string, homeDir: string): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return join(homeDir, value.slice(2));
  return value;
}

/** The daemon home this plugin runs under: `PASEO_HOME` or `~/.paseo`. */
export function resolvePaseoHome(env: NodeJS.ProcessEnv, homeDir: string): string {
  const raw = env.PASEO_HOME && env.PASEO_HOME.trim() !== "" ? env.PASEO_HOME : join(homeDir, ".paseo");
  return expandHome(raw, homeDir);
}

/**
 * Writable per-plugin state root. Everything the factory persists lives here:
 * `ledger.jsonl`, the spool (ADR 0004) and the generated `bin/` that puts
 * `factory-claim` on agent PATHs. Uninstalling the plugin leaves it behind —
 * it is the Owner's data, not the plugin's.
 */
export function stateDirFor(paseoHome: string): string {
  return join(paseoHome, "plugin-state", PLUGIN_ID);
}

/**
 * The plugin's own source directory, as recorded by `paseo plugin install`
 * (`config.json → plugins["paseo-factory"] = {source: "directory", path}`).
 * `undefined` when the config is unreadable or the entry is not a local
 * directory install — callers must degrade visibly, not crash.
 */
export function pluginDirFor(paseoHome: string, pluginId: string = PLUGIN_ID): string | undefined {
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(join(paseoHome, "config.json"), "utf8"));
  } catch {
    return undefined;
  }
  const entry = (config as { plugins?: Record<string, unknown> })?.plugins?.[pluginId];
  if (
    typeof entry === "object" &&
    entry !== null &&
    (entry as { source?: unknown }).source === "directory" &&
    typeof (entry as { path?: unknown }).path === "string"
  ) {
    return (entry as { path: string }).path;
  }
  return undefined;
}
