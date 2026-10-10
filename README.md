# paseo-factory

A verification line for coding agents, delivered as a [Paseo](https://paseo.sh) plugin.

The repo is `paseo-slp-factory`; the plugin/package name is `paseo-factory` (the
divergence is accepted — see ADR 0001).

Work is judged against criteria fixed before it starts: the **Owner** sets a
Contract (one gate command, one artifact), the **Agent** does the work and
claims the task is finished at a specific commit, and the factory — never the
agent — runs the gate and records every step in an append-only ledger it
cannot edit. A green verdict is evidence, not acceptance.

**Status: v0.0.8, pre-release.** The pure verification core is complete and
tested (245 tests); the plugin loads on a Paseo 0.10 daemon, owns the ledger
and the gate as the single writer (ADR 0004), and serves the whole loop over a
file spool: the Owner's `factory` CLI sets Contracts and accepts green
Attempts, the Agent's `factory-claim` CLI submits Claims (it rides every
agent's PATH), and each Claim opens a numbered Attempt that ends in a Verdict
and a per-attempt report — proven end-to-end against a live trial daemon by
`scripts/smoke-loop.mjs`. Since that first wiring the loop has gained the
driver (`factory run`), the record-only watch, the on-demand Retro, and the
Cost read backed by the Meter. Nothing is published yet.

## Layout

- `src/` — the pure core: contracts, JSONL ledger, gate runner, report. Zero
  Paseo imports, zero runtime deps, Node ≥ 22.18.
- `plugin/` — the Paseo plugin shell (`paseo-plugin.json`, server entry,
  `server/spool.ts` for the submit protocol, `bin/` for the CLIs). The daemon's
  plugin compiler refuses imports outside the plugin directory, so
  `plugin/server/core/` is a vendored copy of `src/`, kept byte-exact by
  `npm run sync:plugin-core` (a test fails if the copy drifts).
- `test/`, `fixtures/` — tests for core, shell, spool, and CLIs.
- `docs/adr/` — decision records; `CONTEXT.md` — the domain language.

## Develop

```sh
npm install
npm run typecheck
npm test
```

Edit the core in `src/`, then run `npm run sync:plugin-core` and commit both.

## Run the loop on a trial daemon

Use a dedicated daemon home — never the default `~/.paseo`:

```sh
paseo daemon start --home ~/.paseo-factory          # any 0.10.x daemon
paseo plugin install "$(pwd)/plugin" --home ~/.paseo-factory
paseo plugin ls --home ~/.paseo-factory             # expect: running
```

The **Owner** (you, from this repo) fixes the Workspace in a Contract and later
accepts a green Attempt:

```sh
npm run factory -- --home ~/.paseo-factory contract \
  --task T1 --workspace /path/to/repo --gate "npm test" --artifact src/x.ts
npm run factory -- --home ~/.paseo-factory accept T1 --attempt 2
```

The rest of the Owner surface: `run` (the driver, v0.0.5) takes one or more
contracted task ids plus `--provider <p[/m]>` — per task it cuts the branch
named after the task, spawns one agent through the spool, and watches to the
verdict, exiting 0 only when every task ended green with zero refusals. And
the read side: `status` prints one line per task (attempts, last verdict,
attested sha, accepted, choke counts), `cost` prints the Cost read over the
whole ledger — one row per task plus per-lane totals — and both are local
reads that need no running plugin:

```sh
npm run factory -- --home ~/.paseo-factory run T1 --provider claude/sonnet-5
npm run factory -- --home ~/.paseo-factory status
npm run factory -- --home ~/.paseo-factory cost
```

The **Agent** gets one command, `factory-claim --task T1 --sha <commit>`, on its
PATH automatically. It prints the Verdict, the gate note, and the report path;
exit 0 on green, 1 on red, 2 when the factory did not process the claim.

Gate commands run as children of the plugin, under the daemon's environment —
a daemon launched from the desktop has no nvm on its PATH, so prefer absolute
command paths (e.g. `$(which node) --test`) in Contracts.

The mechanical loop without an agent is one command:

```sh
node scripts/smoke-loop.mjs --home ~/.paseo-factory   # contract → red → green → accept
```

The flaw battery plants deliberately flawed, gate-green work in fixture
workspaces and runs each arm through the same pipeline with `--fresh-eyes` —
the instrument for measuring whether the eye says CONCERN on purpose (four
flaw classes plus a clean control, pre-registered rules in the effort map):

```sh
node scripts/flaw-battery.mjs --home ~/.paseo-factory   # all arms; --arm <name> re-runs one
```

Since v0.0.6 the contract carries `--watch`: a record-only pass after every
verdict — red included — in which a Copilot chat model, prompted headless
through the daemon's `copilot` CLI, reads the run timeline, the Contract, the
diff and the gate output and answers the five fixed questions
(destructive-writes, test-weakened, stuck-loop, scope-creep, secret-leak) into
one `watch_written` ledger line. A passenger, never a judge: verdicts, accepts
and driver exits never read it.

State lives under `<daemon home>/plugin-state/paseo-factory/` — the ledger,
per-attempt reports, the spool (`requests/`, `replies/`, `processed/`), and the
generated `bin/factory-claim` wrapper that rides agent PATHs.

## License

MIT.
