#!/usr/bin/env node
/**
 * The CLI half of the spool protocol (ADR 0004) — shared by `factory-claim`
 * (the Agent's command) and `factory` (the Owner's command). Plain .mjs on
 * purpose: the daemon's node may lack TypeScript stripping, so the CLIs carry
 * no build step and import no plugin server code. The plugin side lives in
 * `plugin/server/spool.ts`; `test/cli.test.ts` runs both halves against each
 * other so the duplicated protocol cannot drift.
 *
 * Writes are write-then-rename so the plugin never reads a half-written
 * request; replies are read only after they land atomically on the plugin side.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Same state root the plugin resolves (`plugin-state/<plugin id>` under the daemon home). */
export function stateDirFor(paseoHome) {
  return join(paseoHome, "plugin-state", "paseo-factory");
}

/** `--home` flag > `PASEO_HOME` > `~/.paseo`, with `~` expansion. */
export function resolveHome({ flag, env = process.env, homeDir = homedir() }) {
  const raw = flag ?? (env.PASEO_HOME && env.PASEO_HOME.trim() !== "" ? env.PASEO_HOME : join(homeDir, ".paseo"));
  if (raw === "~") return homeDir;
  if (raw.startsWith("~/")) return join(homeDir, raw.slice(2));
  return raw;
}

export function spoolRootFor(stateDir) {
  return join(stateDir, "spool");
}

/**
 * Drops a request file and returns it. The id travels in the filename and the
 * body — a reply to this exact id is the only thing this client will accept.
 */
export function submit(spoolRoot, request) {
  const requestsDir = join(spoolRoot, "requests");
  mkdirSync(requestsDir, { recursive: true });
  const path = join(requestsDir, `${request.id}.json`);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(request)}\n`);
  renameSync(tmp, path);
  return path;
}

/** Polls for the plugin's reply; resolves the parsed reply, or null on timeout. */
export function awaitReply(spoolRoot, id, timeoutMs, pollMs = 200) {
  const replyPath = join(spoolRoot, "replies", `${id}.json`);
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      if (existsSync(replyPath)) {
        try {
          resolve(JSON.parse(readFileSync(replyPath, "utf8")));
          return;
        } catch {
          // A half-visible read should be impossible (atomic rename), but if
          // it ever happens, keep polling rather than fail on one bad instant.
        }
      }
      if (Date.now() >= deadline) {
        resolve(null);
        return;
      }
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

export function randomId() {
  return globalThis.crypto.randomUUID();
}
