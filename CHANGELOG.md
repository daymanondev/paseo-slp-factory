# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.0.2] - 2026-10-08

v0.0.2's one thing: after a green Verdict, a different model — called by direct
API from the plugin, no harness (ADR 0005) — reads the Contract, the diff and
the full gate output, and appends one advisory line to the ledger. Evidence for
the Owner, never a second Verdict. Default off; the Contract marks it on.
Proven by live run 2 (2026-10-08): one attempt, gate green, the eye `clear` in
3956 ms — and the run's own working agent taught `factory status` to show it.

### Added

- Fresh-eyes review pass (tickets 02–04):
  - `freshEyes: true` on a Contract marks the pass ON (`factory contract
    --fresh-eyes`); an unmarked Contract behaves exactly like v0.0.1.
  - Green verdicts only, synchronous inside the attempt's closing window:
    `gate_finished` → `fresh_eyes_written` → `report_written`, so the report is
    written once, already containing the eye's line. The pass never touches the
    Verdict or `accept` — advisory by construction.
  - New event `fresh_eyes_written {task, attempt, model, outcome, finding,
    durationMs}`; `outcome` is `concern | clear | failed` (the countable noise
    instrument), `finding` is the eye's ≤ ~120 words, and on `failed` it carries
    the error — deaths are visible, never swallowed.
  - Input bundle: the Contract, the diff `base..claimed` (tail 100K chars), the
    full gate output (tail 50K chars); every truncation leaves a `[truncated]`
    marker and the prompt forbids guessing about cut content. The prompt lives
    in one module (`src/fresh-eyes.ts`), is English, and enforces a hard output
    contract: first line `CONCERN` or `CLEAR`, findings cite `file:line`, and
    the eye proposes patches as text only — it never runs anything.
  - The eye's config is `<stateDir>/eye.json` (mode 600, shape
    `{provider, model, apiKey, baseUrl}`, copied not referenced), read per pass
    so key/model rotation needs no restart. The key never appears in a
    Contract, ledger line, or report.
  - Failure semantics: 60s total budget over both tries (one `AbortController`),
    at most one retry and only on transient failures (network error, 429, 5xx) —
    never on 400/401/403. Every failure lands as a visible `failed` line in the
    ledger and the report. `contract --fresh-eyes` fails fast (`eye-unconfigured`)
    when `eye.json` is missing or unusable, before any agent work starts.
  - The API call is one plain `fetch` (zero runtime deps law): an
    Anthropic-messages `POST {baseUrl}/v1/messages` with `x-api-key`.

### Changed

- Full gate output is persisted (ticket 02a): the capture ceiling rises 4 KB →
  2 MB raw (combined stdout+stderr, interleaved as it arrived), lands beside the
  report as `gate-<task>-<attempt>.log`, and `gate_finished` gains an additive
  `outputPath` pointing at it — the ledger alone can find the evidence. The
  `note` keeps its 200-char one-line summary role, now cut at a word boundary
  with a leading ellipsis when truncated (ticket 02c) — a note never begins
  mid-word.
- `claim_reported` gains an optional `agent` field (ticket 02b) — the spool
  submitter id, stamped by the plugin when the CLI carries `PASEO_AGENT_ID`;
  direct CLI claims stay anonymous. The report renders `Claimed by agent
  \`<id>\``. `factory status` is untouched (task view, not person view).
- `contract_set` records `base` (HEAD at set time) on every Contract (ticket 03
  R2) — it is the diff range for the scope check and the fresh-eyes pass, so a
  workspace without a resolvable HEAD is now refused at contract time, scoped
  or not. Pre-0.0.2 Contracts simply predate the eye; no backfill.
- Recovery generalized (ticket 03 R1): an Attempt that already has its
  `gate_finished` (a restart during the eye's window is the one place that
  happens) gets only its missing report written on reopen — never a second,
  red `gate_finished` over a verdict that already landed.
- `factory status` shows each task's last fresh-eyes outcome: every line gains a
  trailing ` eye=<concern|clear|failed|->` (last-wins; `-` when the pass never ran
  on that task), so the Owner's one-glance view sees the station's output. Built
  by the v0.0.2 live run itself (ticket 06): a working agent under a scoped
  contract (`plugin/bin` + `test`), judged green then read `clear` by the eye's
  first real-task pass — the loop shipped the feature that surfaces it.

## [0.0.1] - 2026-10-07

First runnable loop, proven live end-to-end on a trial Paseo 0.10 daemon.

### Added

- `factory status` — the Owner's read-only glance at the ledger: one line per
  task (attempts, last verdict, attested sha (short), accepted) read directly
  from `ledger.jsonl`, no spool round trip and no running plugin. An
  unreadable ledger is refused (exit 2) rather than guessed around.
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
