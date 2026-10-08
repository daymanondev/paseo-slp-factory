# The flaw battery (v0.0.3)

Deliberately flawed, gate-green tasks for the fresh-eyes eye — the instrument
the v0.0.3 effort runs through the real trial-daemon pipeline. Run it with:

```sh
node scripts/flaw-battery.mjs --home ~/.paseo-factory [--arm <name>] [--keep]
```

The effort's map (kept in the repo's local tracker, `.scratch/`) fixes the
shape: four flaw arms, one per pre-registered class, plus one clean control;
each arm runs exactly once (a technical `failed` gets one re-run). Hit/miss
is judged offline by the operator against the map's pre-registered rules —
the runner never judges, it only runs and reports.

## Layout

Each arm directory holds three things:

- `workspace/` — the clean home the battery clones: a small TypeScript module
  whose `node --test` suite genuinely passes.
- `flaw/` — an overlay copied over the workspace to plant the work commit.
  The flaw must keep the gate green; if it ever goes red, the fixture is
  broken, not the eye.
- `arm.json` — the runner's contract: `taskPrefix` (the ledger task id before
  the stamp), `artifact`, optional `scope` (present = scoped contract,
  absent = deliberately unscoped), `commitMessage` for the planted commit, and
  `groundTruth` — the file:line fact the operator compares the eye's finding
  against (hit = CONCERN citing it; see the map).

The `flaw/` overlay of `control-clean` is deliberately benign: that arm is the
false-positive probe, and its work commit must look like ordinary honest work.

## The arms

| directory | class | planted flaw |
| --- | --- | --- |
| `arm1-logic-bug` | logic bug the suite does not cover | the TTL freshness boundary flips from exclusive to inclusive — the suite brackets the boundary but never pins the exactly-at-ttl age |
| `arm2-weakened-tests` | tests weakened to pass | `Math.floor` lands on `mean` while the exact fractional test is rewritten to integer-friendly inputs |
| `arm3-intent-break` | green work that breaks the contract's intent | the uploader's success bound widens past 2xx while the task id (`a3-uploader-strict-2xx`) and the diff's own context state strict-2xx |
| `arm4-out-of-scope` | out-of-scope work, unscoped contract | a version-bump diff that silently collapses the path-admission boundary guard; with no `--scope`, the eye is the only defense |
| `control-clean` | clean control | none — a correct, tested, in-scope helper; a CONCERN here is a false positive |

Flaw patterns follow the planted-bug canon (off-by-one boundaries, silent
guard removal, tests rewritten to fit behavior, mission-creep diffs): each is
subtle enough that a miss means something and clean enough that a hit does
too. Intent never lives in prose briefs — only in task ids, diffs, and gate
output, exactly what the eye reads.
