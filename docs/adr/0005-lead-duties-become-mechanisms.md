# ADR 0005 — Lead duties become mechanisms; no Lead agent is built

- **Status:** Accepted — 2026-10-07 (ratified by Andrew)
- **Grounded in:** the SLP model (`research/00-overview/02-slp-la-gi.md`), the
  seatworks-source LEAD.md (`research/90-sources/original-files/LEAD.md`), the
  paseo-room Lead contract (`github.com/cuongntr/paseo-room`,
  `src/room/prompts/contract/lead.md`), and codex-room-setup
  (`github.com/hoangnb24/codex-room-setup`, `docs/huong-dan-codex-room-setup.md`).
- **Supersedes:** the map's "decide who plays Lead after the live run". The stance is
  decided ahead of the run; run data calibrates the preconditions, not the direction.

## Decision

- **The factory never builds a Lead agent.** The product exists to minimize how often
  the Owner must prompt; a Lead is something the Owner must prompt. Every duty the
  reference systems give their Lead is absorbed by a mechanism instead:

| Lead duty (as written in the sources) | Factory mechanism | Arrives |
|---|---|---|
| Framing and done-criteria | Contract, set by the Owner (ADR 0002) | v0.0.1 |
| Verification — "a candidate whose gate was not run is not a candidate" | Gate, run by the plugin itself | v0.0.1 |
| Stable checkpoint — the SHA is the durable artifact | Verdict attests the claimed commit (ADR 0002) | v0.0.1 |
| Brief boundaries — owned scope, exclusions, verification command | Contract `scope` field: red Verdict outside declared scope | ticket 14 |
| Independent review — default OFF, on named triggers | Fresh-eyes: read-only pass appending one ledger line | 0.0.2 |
| Routing — spawn per brief, pick the harness | Spawn: one fresh-context Agent per Task, harness-agnostic | 0.0.4 |
| Monitoring — "after two identical failures, check prerequisites instead of retrying" | Attempt cap per Task, set by the Owner | 0.0.4 |
| Repeated-failure reflection — "third same-symptom correction: which mechanism produces this chain?" | Retro: scheduled pass over ledger and reports; proposals only | after 0.0.4 |
| Acceptance — "among agents, Lead alone accepts" | With no Lead, nothing agent-side accepts: the Owner accepts | v0.0.1, permanent |

- **Fresh-eyes is invoked by direct model API from the plugin — no harness.** The
  reviewer only reads the Contract, the diff and the Gate result, then appends one
  line to the Ledger: no tools, no session, therefore no harness. Spawn-through-a-
  harness belongs to 0.0.4, where the ladder already schedules it. Key placement,
  model choice and trigger wiring are 0.0.2's detailed design. It keeps the sources'
  default: independent review is off unless the Contract marks it on.
- **Spawn stays harness-agnostic**, in ADR 0004's spirit: pi and agy-ACP are both
  candidates, chosen per Task by the Owner at Contract time — the ADR pins no harness.
- **Unattended loops** (a driver draining approved Contracts — spawn, gate, next —
  with the Owner absent) are permitted only when three preconditions hold: the core
  implements ADRs 0002/0003 (ticket 13); the scope field enforces red-outside-scope
  (ticket 14); an Owner-set ceiling on Attempts per Task exists. Unattended loops
  commit to branches only.
- **Landing to main is a human act, permanently** — not a rung to remove once
  fresh-eyes and ceilings exist. Acceptance is judgment; green is evidence (ADR 0002).
- **The Owner seat may be delegated later** by the human to exactly one agent,
  revocably, inheriting only the Owner surface: set Contract, accept Attempt. That is
  not a Lead — routing, review and reflection are already mechanisms, and a delegate
  gains no authority over them.

## Considered options

- **Build a Lead agent** (our own, or seatworks' Lead as an Owner): rejected — every
  prompt to a Lead is Owner work, the exact cost this product exists to shrink. The
  reference systems pay it because they run open-ended rooms; the factory runs single
  bounded Tasks.
- **Wait for the live run (ticket 09) before deciding:** rejected for the stance,
  kept for calibration — ticket 14 was blocked on this decision, and run data tunes
  preconditions and costs, not direction.

## Consequences

- **Known gap:** the sources' mid-task escalation (`NEEDS-HUMAN:` / `INCIDENT:` lines
  in LEAD.md and the paseo-room contract) has no factory channel yet. A blocked Agent
  simply never Claims, and the red Verdict is the record. A real channel belongs to
  the 0.0.3 permission-choke rung; recorded here, not designed here.
- "Lead" retires from factory vocabulary (CONTEXT.md's Owner entry is rewritten); it
  remains a seatworks/research term.
- Room machinery (seat lists, role overlays, MCP injection) stays out of the factory —
  the team-organization work that roadmap §4 law 6 already assigns to seatworks.
- Retro's slot on the ladder: after spawn (0.0.4), before the Jev watcher; the exact
  version is decided when the post-run tickets are written, per the ladder's own
  rule that rows after 0.0.2 are provisional.
