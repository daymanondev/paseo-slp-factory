# ADR 0004 — One writer: the plugin owns the Ledger and runs the Gate; CLIs only submit

- **Status:** Accepted — 2026-10-04
- **Deviates from:** roadmap §2 and ticket 08, which delivered two MCP commands to the
  Agent and put Reports inside the Workspace.

## Decision

- **The plugin process is the only writer of the Ledger and the only runner of Gates.**
  The Owner's CLI (`factory contract`, `factory accept`) and the Agent's CLI
  (`factory-claim`) never touch the Ledger: they drop a request file into
  `stateDir/spool/requests/` and wait for the reply. Each request carries an id, so a
  retried call never starts a second Gate.
- **The Agent gets the Claim as a CLI on its `PATH`**, put there by the plugin's
  `agent.session_open` before-hook — not as an MCP tool. It accepts only `--task` and
  `--sha`. *(Amended 2026-10-07, ticket 06: the original wording said `agent.create`;
  that hook's `env` is not re-applied on resume, while `agent.session_open` fires for
  create, resume, refresh and import — daemon `agent-manager.js` `buildLaunchContext` —
  so it is the single injection point.)*
- **All state lives in `stateDir`, outside the Workspace**: Ledger, spool, Reports.
  Reports inside the Workspace would dirty the tree the next Attempt must find clean, and
  the Agent could edit them.

## Why

- If a CLI wrote the Ledger itself, the Gate would run inside the Agent's own process:
  under its tool timeout, killable by it, with its environment. All three reference
  systems funnel writes through one daemon-side writer (seatworks v3 and paseo-room via a
  file spool, seatworks rebuild via a unix socket).
- MCP reaches pi only through pi-mcp-adapter, and Paseo injects without `directTools`, so
  the Agent must go through the adapter's search-then-call proxy — fragile for the GLM
  model chosen for the first run. A shell command works for every provider; seatworks
  rebuild also reaches pi without MCP.

## Considered options

- CLIs write the Ledger directly under an `O_EXCL` lock: rejected for the Gate-placement
  reason above.
- One file per event via hard links (paseo-room) or SQLite (seatworks rebuild): not needed
  with a single writer; JSONL stays until the factory has to write events and to-dos
  atomically together.
