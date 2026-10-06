# ADR 0002 — The Owner sets the Contract and accepts; the Verdict attests to the claimed commit

- **Status:** Accepted — 2026-10-04
- **Deviates from:** roadmap §2 (`research/03-hands-on/05-lo-trinh-paseo-factory.md`, private),
  which gave the Agent both `factory.contract` and `factory.done` and let a green Gate
  conclude "DONE".

## Decision

- **The Owner, never the Agent, sets a Task's Contract**, before the Agent starts. The
  Agent's only factory command is the Claim. Letting the Agent register its own Gate
  meant it graded itself (`gate: "true"` → green), which breaks the invariant the whole
  product rests on: whoever writes the work does not accept it.
- **A Verdict is about the claimed commit, not about whatever is on disk.** The claimed
  sha is resolved with `git rev-parse --verify "<sha>^{commit}"` and stored in full; an
  empty, ambiguous or unknown sha is a red Verdict, never a silent fallback to `HEAD`.
  The Workspace must sit clean with `HEAD` at that commit **before and after** the Gate
  runs; if it moved while the Gate ran, the Verdict is red.
- **The Owner accepts; the Gate does not.** A green Verdict is necessary, not sufficient:
  the Agent can still edit the tests the Gate runs. The Owner records acceptance of a
  specific green Attempt. All three reference systems (seatworks v3 and rebuild,
  paseo-room, codex-room-setup) keep the Gate as evidence and leave acceptance to a Lead.

## Considered options

- Agent proposes, Owner approves (`contract_proposed` → `contract_approved`): rejected for
  v0.0.1 — an Owner round-trip per Task is too heavy before the first live run.
- Derive the commit from `HEAD` instead of taking it in the Claim (paseo-room, seatworks
  v3): rejected — a wrongly claimed sha is exactly the signal the first live run wants.
- Run the Gate in a fresh worktree checked out at the claimed commit (seatworks rebuild):
  stronger, deferred to the version that adds parallel Tasks.

## Consequences

- v0.0.1 enforces the Owner/Agent split by surface (the Agent is only handed the Claim),
  not by sandbox: an Agent with a shell could still bypass it. Every reference system
  concedes the same. Hard enforcement belongs to the permission-choke version.
