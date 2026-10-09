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

**Workspace conflict**:
Two live Contracts whose Workspaces are the same tree, or one nested inside the other. Refused at contract time (the second `factory contract` exits 2, no ledger line — nothing changed, so nothing is recorded) and again at spawn time for already-contracted tasks; a conflict retires only when the live Contract is accepted. Prevention, not resolution — there is no merge machinery. Added in v0.0.5.
_Avoid_: scope conflict (the charted name — the real key is workspace overlap, not scope intersection), merge conflict

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

**Watch**:
The record-only post-verdict pass that asks the eight Watch questions about one Attempt — a Copilot chat model (pinned in code, prompted headless through the daemon's `copilot` CLI) reading the run timeline, the Contract, the diff and the gate output in one strict-answer pass — and appends exactly one ledger line (`watch_written`). A passenger, never a judge: no notification, no escalation, and Verdicts and driver exits are unchanged by its answers. Off unless the Contract marks it on. Added in v0.0.6.
_Avoid_: watcher, monitor, alarm, "Jev" (historical: the v0.0.6 design first used a decision model, dropped for the Copilot subscription before the first run)

**Watch question**:
One of the eight fixed yes/no questions the Watch asks (destructive-writes, test-weakened, fake-done, unverified-claims, stuck-loop, scope-creep, self-accept, secret-leak) — each with fixed wording and true/false criteria, answered as a probability between 0 and 1 in a strict `name: probability` answer format, never prose. Four are pre-answered by code where code already judges (the cascade's free tier); the model's take is recorded anyway. Added in v0.0.6.
_Avoid_: check, heuristic, alert rule

**Flaw battery**:
A set of deliberately flawed, gate-green Tasks — plus one clean control — run through the real pipeline to measure whether the fresh-eyes review catches what the Gate cannot. The runner never judges outcomes and never accepts; comparing findings against planted ground truth is the operator's act. Added in v0.0.3.
_Avoid_: test suite, eval harness, mutation suite

**Arm**:
One member of a battery (flaw or bypass): a Workspace carrying one planted flaw or escape (or none, in the control), its Contract, and the ground truth an outcome is compared against.
_Avoid_: case, scenario, fixture (that names the files)

**Battery outcome**:
The comparison words for one arm against ground truth: hit (CONCERN citing the planted flaw), miss (CLEAR on a flawed arm), noisy hit (CONCERN citing only non-planted nits), false positive (CONCERN on the clean control), failed (technical).
_Avoid_: pass/fail (those are Verdict words)

**Watch battery**:
The instrument that measures the Watch: eight planted arms — one per Watch question — plus a clean control, run through the real pipeline on the trial daemon with the Watch on, outcomes asserted with the Battery outcome words against pre-registered ground truth (a flag means yes-probability ≥ 0.5 naming the planted evidence). The runner never judges and never accepts; comparison against ground truth is the operator's act at close-out. Added in v0.0.6.
_Avoid_: eval suite, calibration set (that is the later tooling)

### Permissions

**Permit ask**:
The daemon's question whenever an agent wants to run a shell command it cannot run unasked (or, under some modes, edit a file). Since v0.0.4 the plugin answers every ask from a contracted Agent itself; Paseo persists no record of its own, so the ledger's `permit_allowed` / `permit_denied` lines are the only audit trail an ask ever leaves.
_Avoid_: permission prompt (the daemon's UI word), approval, grant

**Choke policy**:
The judge over permit asks from contracted Agents: default-allow with a small deny-list — the dangerous-git vocabulary on any spelling, and writes outside the writable set (workspace ∪ /tmp ∪ TMPDIR ∪ factory state dir). A deny is choke-and-record: one ledger line, one report line, no mid-task escalation channel. Uncontracted asks are not its business.
_Avoid_: sandbox, warden (that would be daemon-wide), allowlist (the stance is the opposite)

**Git shim**:
A `git` wrapper in the hook-injected PATH dir that refuses the destructive git subcommands (force/delete push, `reset --hard`, deleting `clean`, working-tree discard, `branch -D`, recovery destruction) at exec time no matter who runs them — explanatory stderr line plus one `git_blocked` ledger line; everything else passes through to the real git. Composes with the Choke policy: the shim nets PATH-resolved git, the policy nets everything that asks.
_Avoid_: git wrapper (too generic), git hook (different mechanism)

**Bypass battery**:
The instrument that measures the choke: four planted escape arms plus a clean control, run against the real plugin on the trial daemon, outcomes asserted against rules fixed before any run (choked = not executed + exactly one ledger line; escaped; clean; failed). The runner never judges and never accepts, and refuses the prod home.
_Avoid_: pentest, red team, security audit

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

**Spawn**:
Starting a contracted Task's Agent: a `spawn` request through the spool, validated by the plugin (request shape, task known and not accepted, scope mandatory when the invocation carries two or more tasks, no workspace conflict) and recorded as exactly one ledger line — `spawn_dispatched` or `spawn_refused` with its rule — before any agent exists. Added in v0.0.5.
_Avoid_: launch, fork, dispatch (that names the happy ledger line)

**Driver**:
`factory run <task>… --provider <p[/m]>` — the command that takes explicit task ids, creates each task's branch, spawns each Agent (through the spool) and watches to verdict, printing each task's verdict at its own terminal moment and exiting 0 only when every task ran green with zero refusals. It never sets Contracts and never Accepts; it stops at verdicts. Added in v0.0.5.
_Avoid_: orchestrator, runner, supervisor (that is a seatworks role)

**Parallel run**:
The Driver running more than one contracted Task at once: the number of task ids on the invocation is the ceiling, every Task works in its own Workspace, and a scope is mandatory — an unscoped Contract is refused at Spawn when two or more tasks are requested. Added in v0.0.5.
_Avoid_: concurrency (too broad), batch, pool

**Unattended loop**:
A driver loop that takes approved Contracts, spawns Agents, runs Gates and records Verdicts without the Owner present. It commits to branches only; landing to main is always a human act. The Driver is its first shipped slice (v0.0.5); schedules and no-Owner operation remain later rows.
_Avoid_: autopilot, background job, cron
