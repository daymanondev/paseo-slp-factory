# ADR 0003 — Ledger shape: Attempts, timestamps, and `claim_reported`

- **Status:** Accepted — 2026-10-04
- **Deviates from:** the literal five-line ledger in roadmap §2
  (`research/03-hands-on/05-lo-trinh-paseo-factory.md`, private).

## Decision

Changed before the first live run, while no real Ledger exists to migrate:

- **Every event carries `ts`** (ISO 8601, UTC). A Ledger with no time is not an audit
  trail, and later versions need durations and cost per Attempt. Report timestamps come
  from events, not from render time.
- **A Task has numbered Attempts.** Each Claim opens Attempt `n`; every event after the
  Contract carries `attempt`; each Attempt gets its own Report (`report-<task>-<n>.md`),
  so Reports are never overwritten. A Claim while the previous Attempt's Gate is still
  running is rejected. Previously, concurrent Claims interleaved and a Report paired one
  Claim's commit with another's Gate result. *(Amended 2026-10-10, v0.0.8 ticket 04, to
  record drift that began with v0.0.4: the task-scoped events carry no `attempt` — the
  choke lines (v0.0.4) belong to the Task's whole life, the spawn lines (v0.0.5) precede
  any attempt, and `meter_written` (v0.0.8) spans the whole run. `attempt` marks the
  Attempt's loop, not a shape every event must wear; `retro_written` (v0.0.7) carries
  no task at all — the factory-level event.)*
- **`done_reported` is renamed `claim_reported`**: the Agent makes a Claim; a Task is
  Accepted only when the Owner accepts a green Attempt (ADR 0002). "Done" stays out of
  the Agent's vocabulary.

## Recovery

- **A final line with no trailing newline is moved to a quarantine file on open; any other
  damage still refuses to open.** `append` returns only after the line *and* its `\n` are
  fsynced, so an unterminated last line was never acknowledged to anyone — dropping it
  loses no recorded fact. Seatworks and paseo-room refuse on any damage; this is the one
  case where refusing would brick the factory over nothing.
- **An Attempt with `gate_started` but no `gate_finished` is closed red on open**, with the
  note "interrupted — the factory restarted before the Gate finished". No green was ever
  established, so red is the fact, not a guess.
- **No cap on Attempts in v0.0.1.** Attempts are numbered and shown in the Report; a cap
  waits for live-run data.

## Considered options

- One Claim per Task (red → open a new Task): rejected — it splits the red → fix → claim
  again loop, the very thing the first live run is meant to observe, across unrelated ids.
