# paseo-factory

A verification line for coding agents, delivered as a [Paseo](https://paseo.sh) plugin.

The repo is `paseo-slp-factory`; the plugin/package name is `paseo-factory` (the
divergence is accepted — see ADR 0001).

Work is judged against criteria fixed before it starts: the **Owner** sets a
Contract (one gate command, one artifact), the **Agent** does the work and
claims the task is finished at a specific commit, and the factory — never the
agent — runs the gate and records every step in an append-only ledger it
cannot edit. A green verdict is evidence, not acceptance.

**Status: v0.0.1 shell, pre-release.** The pure verification core is complete and
tested (41 tests); the plugin shell loads on a Paseo 0.10 daemon, resolves its
state root under the daemon home, opens the ledger, and puts the `factory-claim`
stub CLI on every agent's PATH (ADR 0004: CLIs, not MCP tools). The loop itself —
submitting a claim runs the gate — lands with the next tickets. Nothing is
published yet.

## Layout

- `src/` — the pure core: contracts, JSONL ledger, gate runner, report. Zero
  Paseo imports, zero runtime deps, Node ≥ 22.18.
- `plugin/` — the Paseo plugin shell (`paseo-plugin.json`, server entry). The
  daemon's plugin compiler refuses imports outside the plugin directory, so
  `plugin/server/core/` is a vendored copy of `src/`, kept byte-exact by
  `npm run sync:plugin-core` (a test fails if the copy drifts).
- `test/`, `fixtures/` — tests for core and shell.
- `docs/adr/` — decision records; `CONTEXT.md` — the domain language.

## Develop

```sh
npm install
npm run typecheck
npm test
```

Edit the core in `src/`, then run `npm run sync:plugin-core` and commit both.

## Try the shell on a trial daemon

Use a dedicated daemon home — never the default `~/.paseo`:

```sh
paseo daemon start --home ~/.paseo-factory          # any 0.10.x daemon
paseo plugin install "$(pwd)/plugin" --home ~/.paseo-factory
paseo plugin ls --home ~/.paseo-factory             # expect: running
paseo plugin logs paseo-factory --home ~/.paseo-factory
```

State lives under `<daemon home>/plugin-state/paseo-factory/` — ledger, spool,
and the generated `bin/factory-claim` wrapper that rides agent PATHs.

## License

MIT.
