# paseo-factory

A verification line for coding agents: the work is judged against criteria fixed before
it starts, by running checks rather than trusting the agent's word, and every step is
recorded so it can be read back later.

## Language

### People and parties

**Agent**:
The coding agent doing the work on a Task. It may make Claims; it never sets or changes a Contract.
_Avoid_: worker, peer (in this context), bot

**Owner**:
Whoever sets a Task's Contract — the human, or an agent the human has explicitly delegated the Owner seat to (revocably). Never the Agent working that Task.
_Avoid_: supervisor, reviewer, user, Lead (that is a seatworks role, not a factory one)

### Work and criteria

**Task**:
One unit of work, identified by a filename-safe id, judged against exactly one Contract.
_Avoid_: job, ticket, lane

**Contract**:
The Owner's done-criteria for a Task, fixed before the Agent starts: one Gate command and one Artifact, run in one Workspace.
_Avoid_: spec, acceptance criteria, hợp đồng (outside research notes)

**Workspace**:
The git working copy a Task's work lives in; the Gate runs there and the Artifact is resolved inside it.
_Avoid_: repo, project dir, cwd

**Gate**:
The command named in a Contract whose exit status is the factual check of the work.
_Avoid_: test step, check, cổng (outside research notes)

**Artifact**:
A path inside the Workspace that must exist for a Verdict to be green. It can never point outside the Workspace.
_Avoid_: deliverable, output file

### Judging

**Claim**:
The Agent's statement that a Task is finished at a specific commit. A Claim is evidence of intent, never of completion.
_Avoid_: "done" (for the Agent's side), report, submission

**Attempt**:
One Claim and the Gate run it triggers. A Task may have many Attempts; they are numbered and never overlap.
_Avoid_: retry, run, iteration

**Verdict**:
The factory's red/green judgment of one Attempt. Green means the Workspace sat clean at the claimed commit both before and after the Gate, the Gate exited 0, and the Artifact exists. Green is evidence, not acceptance.
_Avoid_: result, status, pass/fail

**Accepted**:
The state of a Task after the Owner accepts one of its Attempts. Only an Attempt with a green Verdict can be accepted.
_Avoid_: done, finished, complete, passed

**Fresh-eyes review**:
A second judgment of a green Attempt by a different model that took no part in writing it — one direct-API read of the Contract, the diff and the gate output, appending one advisory ledger line (`fresh_eyes_written`). Evidence for the Owner, never acceptance; off unless the Contract marks it on. Added in v0.0.2.
_Avoid_: mắt soi (outside research notes), code review, self-review

**Flaw battery**:
A set of deliberately flawed, gate-green Tasks — plus one clean control — run through the real pipeline to measure whether the fresh-eyes review catches what the Gate cannot. The runner never judges outcomes and never accepts; comparing findings against planted ground truth is the operator's act. Added in v0.0.3.
_Avoid_: test suite, eval harness, mutation suite

**Arm**:
One member of a flaw battery: a Workspace carrying one planted flaw (or none, in the control), its Contract, and the ground truth a finding is compared against.
_Avoid_: case, scenario, fixture (that names the files)

**Battery outcome**:
The comparison words for one arm against ground truth: hit (CONCERN citing the planted flaw), miss (CLEAR on a flawed arm), noisy hit (CONCERN citing only non-planted nits), false positive (CONCERN on the clean control), failed (technical).
_Avoid_: pass/fail (those are Verdict words)

**Retro**:
A scheduled fresh-context pass that reads the Ledger, Reports and gate notes and emits proposals — new Gate checks for repeated failures, draft Contracts for knowledge gaps. It never applies its own proposals.
_Avoid_: retrospective (the agile ceremony), postmortem

### Records

**Ledger**:
The append-only record of every event in the factory; lines are never edited or removed.
_Avoid_: log, history, sổ (outside research notes)

**Report**:
The human-readable account of one Attempt, generated from the Ledger, with every line traceable to a Ledger event.
_Avoid_: summary, biên bản (outside research notes)

### Running

**Unattended loop**:
A driver loop that takes approved Contracts, spawns Agents, runs Gates and records Verdicts without the Owner present. It commits to branches only; landing to main is always a human act. Not part of v0.0.1.
_Avoid_: autopilot, background job, cron
