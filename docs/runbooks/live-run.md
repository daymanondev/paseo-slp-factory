# Runbook — live run: one task through the factory

The ritual as it has actually run three times — ticket 09 (v0.0.1,
`.scratch/factory-v0.0.1/issues/09-live-run.md`), ticket 06 (v0.0.2,
`.scratch/factory-v0.0.2/issues/06-live-run-2.md`) and ticket 03 (v0.0.4,
`.scratch/factory-v0.0.4/issues/03-live-measurements.md`); those run logs are
the primary sources, this file is the operator's checklist. Follow it top to
bottom. The baseline in step 2 is a step, not a virtue: skipping it makes a
later red unattributable (ticket 09's attempt 1 went red for an environment
reason, and only the green baseline made that legible).

## Standing rules

- Every `paseo` / `factory` command targets the trial home `~/.paseo-factory`.
  The default `~/.paseo` is PROD — never touch it from a run.
- Non-interactive shells start without `~/.local/bin` (paseo) and without nvm
  (node) on PATH. Export first (adjust when the nvm default moves — it is
  v24.21.0 as of 2026-10-08):

      export PATH="$HOME/.local/bin:$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"

- One ledger writer: the plugin. The CLIs submit through the spool; nobody
  edits `ledger.jsonl` by hand (ADR 0004).
- Accept and landing are Owner acts (ADR 0002 / ADR 0005) — step 9 records the
  delegation convention for when Andrew hands them over.

## 1. Preflight

- Daemon alive: `paseo status --home ~/.paseo-factory`.
- Plugin loaded: `paseo plugin ls --home ~/.paseo-factory` lists `paseo-factory`.
- Agent provider available: `paseo provider ls --home ~/.paseo-factory`
  (09 ran `claude` opus-4-8 at ~$4.07 / 26 min; 06 ran `claude` sonnet-5 at
  ~$1.02 / 6 min on a similar-size task — the Agent's model is a real cost
  dial, and the eye does not care who wrote the diff).
- When the run measures the eye:
  `~/.paseo-factory/plugin-state/paseo-factory/eye.json` exists and is mode
  600. Credentials are placed by the human before the run, never from inside
  it.

## 2. Baseline — mandatory, before the agent exists

On main, in the task's workspace: `npm test` and `npm run typecheck`, both
green; record the counts in the ticket (06 recorded "baseline 100/100
confirmed on main"). A gate verdict is only meaningful against a known-green
baseline — this step is what keeps a red from being misattributed to the
working agent.

## 3. Branch

`git switch -c live<NN>/<slug>` from main in the real workspace. Landing to
main stays a human act (ADR 0005).

## 4. Contract — the Owner CLI, set before the agent starts

    node plugin/bin/factory.mjs --home ~/.paseo-factory contract \
      --task live<NN>-<slug> \
      --workspace /absolute/path/to/workspace \
      --gate "<absolute-node> --test \"test/*.test.ts\"" \
      --artifact <workspace-relative path> \
      [--scope plugin/bin,test] \
      [--fresh-eyes]

- The gate runs under the daemon's env, which has no nvm — resolve node
  absolutely when the contract is set (`$(which node)`), or the suite dies at
  exit 127 inside the gate (ticket 09, attempt 1). The same law applies to
  anything else the gated suite resolves from PATH.
- `--scope` (first live use in ticket 06): workspace-relative prefixes the
  diff may touch; anything outside goes red. Keep it tight — it is the
  mechanical refusal lane. Note: the drift guard between `src/` and
  `plugin/server/core/` means a task not about that sync should scope away
  from the copy it does not touch.
- `--fresh-eyes` only when the run means to measure the eye (it needs
  `eye.json`, checked in step 1).
- `contract_set` records the base sha; note it in the ticket.

## 5. Spawn the working agent

Through the trial daemon only — its agents get `factory-claim` on PATH via the
before-hook (ADR 0004):

    paseo run --background --title <task-id> \
      --provider <provider[/model]> --home ~/.paseo-factory "<brief>"

Provider-default permission mode maps to "Always Ask" — that is expected.
For a contracted agent the create-time pin (v0.0.4) forces exactly that, and
the choke (step 6) answers the asks; for a non-contract agent the manual
loop (step 6) absorbs them.

**The brief — fixed template, edit only the placeholders:**

> Do the assigned work on branch `<branch>`. When done: commit, run
> `git rev-parse HEAD`, then `factory-claim --task <task-id> --sha <sha>`.
> If the result is RED: read the note line, fix, make a NEW commit, claim
> again with the new sha. Never edit tests just to make them green.
>
> Your shells under the daemon start without git/node/npm on PATH — export
> PATH="$HOME/.local/bin:$HOME/.nvm/versions/node/v24.21.0/bin:$PATH" first.

## 6. Permits

For a **contracted agent there is nothing to run** (v0.0.4): the choke
answers every ask itself — allow by default, deny + one `permit_denied`
ledger line on the deny-list — and the create-time mode pin makes sure the
asks always surface. Measured live in ticket 03 (v0.0.4): 20 asks, all
answered by the plugin, 0 operator permit acts. Paseo itself persists no
permission record, so the ledger's `permit_allowed` / `permit_denied` /
`git_blocked` lines are the run's only audit trail — `factory status` shows
them per task as `choke=<allowed>/<denied>/<blocked>`.

Non-contract agents are not the choke's business (map decision 5) — for
those, the manual fallback remains, one terminal started before the agent's
first shell command:

    node scripts/permit-loop.mjs --home ~/.paseo-factory --agent <agent short id>

One stdout line per grant; the grant count is that run's permit metric
(09: ~10 grants, 06: 19 — the parade that motivated the choke).

## 7. Monitor

    tail -f ~/.paseo-factory/plugin-state/paseo-factory/ledger.jsonl
    paseo plugin logs paseo-factory --home ~/.paseo-factory

On a red: read the note, then the full gate output at the event's `outputPath`
before blaming the agent — the note is a capped tail and can hide the root
cause (in 09 the `npm: command not found` line sat above the tail window).

## 8. Findings

The ticket's own questions first, then the standing four (ladder §3): what
the eye caught that the gate missed (nothing is data too), noise level, cost
per pass, and the Owner-work count. Write them into the ticket before
close-out; "the concern path has never fired in live usage" was visible only
because both runs wrote their findings down.

## 9. Close-out

- **Accept** — the Owner's word, then:

      node plugin/bin/factory.mjs --home ~/.paseo-factory accept <task-id> --attempt <n>

- **Delegation convention** (fixed in 09, reused in 06): when Andrew says
  "bạn làm đi" / "tự làm hết đi" (both mean "you do it"), the Owner seat
  (accept) and the git flow (push / PR / merge, plus a tag when a version is
  being cut) are delegated to the operator for that run — revocable, and
  recorded in the ticket as "0 manual acts, N delegations".
- **Landing**: PR into main, CI green before merge, branch deleted after
  (ADR 0001).
