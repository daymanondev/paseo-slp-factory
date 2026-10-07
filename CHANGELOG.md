# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The wired loop (ticket 08, ADR 0004): the plugin process is the single
  Ledger writer and Gate runner, and the CLIs only submit through
  `stateDir/spool/` (`requests/` → `replies/` → `processed/`, atomic writes,
  request ids so a replayed request never starts a second Gate). Three real
  CLIs replace the stub and the planned MCP tools:
  - `factory contract --task --workspace --gate --artifact [--scope]` — the
    Owner fixes the Workspace (absolute, existing directory) in the Contract.
  - `factory accept <task> --attempt <n>` — the Owner accepts one green
    Attempt (new `attempt_accepted` ledger event; red attempts, unknown
    attempts and double acceptance are refused).
  - `factory-claim --task --sha` — the Agent's single command; prints verdict,
    gate note and report path (exit 0 green / 1 red / 2 not processed). The
    PATH wrapper now bakes in `FACTORY_STATE_DIR`.
  - `scripts/smoke-loop.mjs --home <trial home>` — the mechanical DoD: contract
    → red claim → fixed green claim → accept against a live daemon, asserting
    the ledger sequence and per-attempt reports.
- ADR 0003 ledger shape, completed: every event carries `ts` (ISO 8601 UTC,
  stamped by the ledger); Tasks have numbered Attempts — each Claim opens the
  next one, a Claim while the previous Attempt is open is rejected, and each
  Attempt gets its own `report-<task>-<n>.md`. On open, an unterminated last
  ledger line is moved to `<ledger>.quarantine`, and an Attempt interrupted by
  a restart (e.g. mid-gate) is closed red and reported.
- Plugin shell (ticket 06): the Paseo plugin that loads on a 0.10 daemon
  (`paseo-plugin.json`, `requirements.paseo >=0.10.0 <0.11.0`). The server entry
  logs a startup banner, resolves the state root under the daemon home
  (`PASEO_HOME` → `plugin-state/paseo-factory/`), opens the ledger through the
  vendored core, and injects the `factory-claim` CLI onto every agent's PATH
  via the `agent.session_open` before-hook (ADR 0004: CLIs, not MCP tools; the
  hook fires on create/resume/refresh, which `agent.create` env alone does
  not). The CLI is a stub until the loop is wired. `plugin/server/core/` is a
  byte-exact vendored copy of `src/` (the daemon compiler rejects imports from
  outside the plugin directory), kept in sync by `npm run sync:plugin-core`
  and guarded by a test.
- README stating what the plugin is and its status (ADR 0001).
- Verification core v0.0.1 (ticket 07), pure Node with zero Paseo imports:
  - Contract registration (`contract_set`): gate command + required artifact path per task.
  - Append-only `ledger.jsonl` with monotonically increasing `seq`, fsync per line,
    corruption detection on open, and the five roadmap events (`contract_set`,
    `done_reported`, `gate_started`, `gate_finished`, `report_written`).
  - Gate runner: spawns the contract command in the task workspace, captures exit
    code and a capped stdout tail, kills the process group after a timeout, and
    requires the artifact to exist for a green verdict. A gate that cannot start
    (e.g. missing workspace) records a red `gate_finished` — the ledger always
    reaches its verdict event.
  - Report generation: `report-<task>.md` rendered from the ledger — contract,
    agent's claim @ SHA, gate verdict, conclusion — every line traceable to a
    ledger event.
- CI: typecheck + test on push and PR (ADR 0001, "CI from day one").
