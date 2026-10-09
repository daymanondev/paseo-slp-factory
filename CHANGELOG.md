# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.4] - 2026-10-09

v0.0.4's one thing: the permission choke. Factory-side policy answers every
permit ask from a contracted agent (default-allow + a small deny-list), a git
shim in the hook-injected PATH refuses the destructive git subcommands at exec
time no matter who runs them, and the permission mode is pinned at agent
creation so asks always surface. Proven by two pre-registered measurements on
the trial daemon (ticket 03), both first-attempt: a bypass battery — four
planted escape arms plus a clean control — **choked 4/4 arms with exactly one
ledger line each, control clean** (ledger seq 128–137; the shim killed the
PATH-resolved `git push --force` with the remote unmoved; the policy denied
the `/usr/bin/git` spelling, the `bash -c` disguise (both S1) and the
`~/.ssh` append (S2)); and one ordinary live run whose working agent's **20
permit asks were all answered by the plugin — 0 operator permit acts, 0
denied, 0 unintended allows** (seq 138–162; gate green 148/148; the run cost
$1.01, unchanged from the pre-choke baseline — the parade is the same size,
the factory answers it now). Paseo itself persists no permission record, so
the ledger is the only audit trail an ask ever leaves.

### Added

- The choke (tickets 01–02): `src/choke.ts` (pure policy) wired by
  `plugin/server/choke.ts` — an `agent.permission_requested` listener that
  reads the full request from the agent handle (`detail.command`, never the
  `permit ls` projection) and answers via `respondToPermission()`;
  contracted agents only (an ask counts as contracted when its cwd sits
  inside a live Contract's workspace); the mode pinned to Always Ask in the
  `agent.create` before-hook. New ledger events `permit_allowed` /
  `permit_denied` / `git_blocked` (task-scoped, no attempt), one line per
  decision; every task report gains a Choke section; `factory status` shows
  per-task counts as `choke=<allowed>/<denied>/<blocked>` — taught to status
  by the version's own live run (`choke=0/0/0` when none: zero is data).
  Deny-list v1: the dangerous-git vocabulary on any spelling (S1 — catches
  absolute-path and `bash -c`-wrapped force-pushes) and writes outside the
  writable set workspace ∪ /tmp ∪ TMPDIR ∪ state dir (S2 — protects
  `~/.paseo`, `~/.ssh`, home dotfiles). Exact-token matching keeps
  `--force-with-lease`, `fetch -f`, `checkout -b`, `clean -n` clear; known
  gaps (force-with-lease rewind, var indirection, config-alias hiding)
  recorded in the research note, not choked.
- The git shim: a generated `<stateDir>/bin/git` wrapper (beside
  `factory-claim`, same hook mechanics) that refuses the six destruction
  classes — force/delete push (incl. `+`/`:` refspecs), `reset --hard`,
  deleting `clean`, working-tree discard (`checkout`/`restore`/`switch`),
  `branch -D`, recovery destruction (`reflog expire --expire=now`,
  `gc --prune=now`) — with exit 126, an explanatory stderr line (the agent
  sees why and can adapt) and one `git_blocked` ledger line ingested
  exactly-once (restart-safe). Everything else passes through to the real
  git. The refusal list lives in both the TS core and a daemon-safe plain JS
  copy, drift-guarded by one shared ~150-case table both must answer
  identically. The two layers compose: the shim nets PATH-resolved git, the
  policy nets everything that asks.
- The bypass battery: `fixtures/bypass-battery/` (four escape arms + clean
  control, each with recorded ground truth) and `scripts/bypass-battery.mjs`
  — the runner that stages scratch workspaces (diverged local bare remotes
  for push arms, so an unchoked force-push visibly moves a ref), sets real
  Contracts, and asserts the pre-registered outcomes mechanically (choked /
  escaped / clean / failed, one technical re-run per arm). It never judges,
  never accepts, and refuses the prod home.

### Changed

- The runbook's permit step retires the manual loop for contracted runs
  (`scripts/permit-loop.mjs` stays as the fallback for non-contract agents);
  `CONTEXT.md` gains the Permissions vocabulary — Permit ask, Choke policy,
  Git shim, Bypass battery.

## [0.0.3] - 2026-10-08

v0.0.3's one thing: the eye's CONCERN path, proven on purpose. A battery of
four deliberately flawed, gate-green Tasks — one per pre-registered flaw
class — plus a clean control, run through the real trial-daemon pipeline;
outcomes judged against rules fixed before any run. Both live runs read the
same: the first (prompt blob `ac0b07c`) and the confirmation (the shipped
prompt, after this version's single prompt-edit window) each landed **4/4
hits with `file:line` localization and a CLEAR control** — every planted
class caught (logic bug the suite misses, tests weakened to pass, a green
intent break, out-of-scope work under an unscoped contract), 0 misses, 0
false positives, 0 failed passes; $0 per pass (quota lane), latency ≤ 21% of
the 60 s budget. Not established by design: variance across repeats, larger
diffs, intent not legible from the diff — that stays with the later
characterization row. The roadmap's original 0.0.3 row (the permission
choke) is displaced to 0.0.4 by this experiment. The battery re-runs
whenever the eye's model rotates: `node scripts/flaw-battery.mjs --home
<trial home>`.

### Added

- The flaw battery — the v0.0.3 concern-path experiment's instrument
  (ticket 02): `fixtures/flaw-battery/` (four flaw arms, one per
  pre-registered class — logic bug the suite misses, tests weakened to pass,
  green work that breaks the contract's intent, out-of-scope work under an
  unscoped contract — plus a clean control; each arm a clean `workspace/`, a
  `flaw/` overlay planted as the work commit, and an `arm.json` carrying the
  task prefix, scope, and ground truth) and `scripts/flaw-battery.mjs`, the
  runner: clone → contract (`--fresh-eyes`) → plant → claim → assert the
  six-event ledger sequence → one outcome+finding line per arm. A technically
  `failed` eye gets exactly one re-run of that arm. The runner never judges
  hit/miss (the operator's act against the map's pre-registered rules) and
  never accepts anything. Proven hermetically by `test/flaw-battery.test.ts`
  (fake eye API + the real CLIs over an in-process spool): per-arm sequences,
  scope wiring, the re-run rule, and exit-reflects-outcomes.

### Changed

- The eye's CLEAR discipline (v0.0.3's single prompt-edit window): the
  answer-shape line now bounds a CLEAR finding to "at most one sentence or
  nothing at all" — CONCERN findings keep their ≤120-words + `path:line`
  discipline untouched. Rider justified by ticket 06's 46-word CLEAR and the
  battery's own control arm (a four-sentence CLEAR); prompt-only, no parser
  change. Measured by a clean full battery re-run before the version tag
  (the shipped prompt's per-arm outcomes, recorded in the version notes).
- `CONTEXT.md` gains the battery's vocabulary — Flaw battery, Arm, and the
  Battery outcome comparison words (hit / miss / noisy hit / false positive /
  failed) — now that the battery ships as a public, re-runnable artifact.

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
