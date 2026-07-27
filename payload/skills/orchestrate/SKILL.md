---
name: orchestrate
description: Execute a planned phase by fanning out tightly-scoped implementer subagents — slice the phase by file ownership, write the shared seam yourself first, dispatch one sonnet task-worker per slice in waves, then review each worker's REPORT (never its diff) and approve or send it back. Use to drive a `.claude/plans/<slug>/` phase to done without pulling the implementation into this context.
argument-hint: '[<phase> | all] [--auto]'
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, Agent, SendMessage
---

Drive planned work to done as **planner → orchestrator → reviewer**: **$ARGUMENTS**

You stay expensive and small. The implementation happens in cheap, tightly-scoped `task-worker`
subagents, and what comes back to you is a **report**, not a diff. Your context holds the plan, the
seam, and N one-screen reports — never the code the workers wrote.

**The economy, stated once:** you pay `O(slices × report)` plus the seam you write yourself. A
worker that reads twelve files and writes six pays for that itself, in a context that dies when its
slice does. That is also the anti-rot argument — no worker accumulates the other slices' history.

## 0. Preconditions and arguments

This skill executes a **plan that already exists**. Read it first:

```
ls .claude/plans/*/ROADMAP.md
```

- **No plan workspace?** Stop and run `/plan-project "<what to build>"` first (the `plans` module).
  Orchestration without a persisted phase boundary has nothing to slice and nowhere to record status.
- **Trivial work?** If the phase is a handful of files you'd finish in one pass, **do it yourself**.
  Briefs, dispatch, and review cost more than the work below roughly two slices.

Resolve `$ARGUMENTS`:

| Argument | Means                                                                        |
| -------- | ---------------------------------------------------------------------------- |
| _(none)_ | the phase currently `IN PROGRESS` in `ROADMAP.md`; if none, the first `TODO` |
| `<N>`    | phase N specifically                                                         |
| `all`    | every remaining phase, in ROADMAP order                                      |
| `--auto` | with `all`: do **not** stop for user check-in between phases                 |

**Default is check-in.** After each phase closes, report what landed and stop for the user. `--auto`
suppresses only that pause — it never suppresses a `BLOCKED` stop (§7).

## 1. Slice the phase

Read the phase sub-plan (`phase-N-<slug>.md`). Break its steps into **slices**: the unit one worker
owns end to end.

A well-formed slice has:

- **`owns`** — the exact paths/globs that worker may write. Nothing outside them.
- **a falsifiable done** — a command whose output proves it (a named test, a build, a grep).
- **a brief that fits on one screen** — if it needs more than ~8 steps or touches more than ~6
  files, split it.

**File ownership is the parallelism constraint — not conceptual independence.** Two slices may run in
the same wave **iff their `owns` sets are disjoint**. Two "unrelated" features that both edit a
barrel export are not parallel; they serialize or one of them gives that file up.

**Orchestrator-owned files** never appear in any worker's `owns`: lockfiles, generated indexes,
barrel/export files, shared type modules, migrations, config. You edit those (§2). Workers that need
a change there **request it in their report** — they don't reach for it.

## 2. Write the seam yourself — before any fan-out

Contract-first is what makes parallel slices safe. Before dispatching a wave, **you** write the
shared surface it depends on: interfaces, type signatures, function stubs, config keys, the
migration, the route table. Small, high-leverage, and exactly the judgment you're the expensive model
for.

Commit it to disk before fanning out. Workers then implement **against a fixed seam** instead of
guessing at each other's shapes — which is the failure that makes parallel agent work produce
merge-conflicted mush.

If a wave's slices would have to negotiate an interface between themselves, the seam isn't written
yet. Write it, then dispatch.

## 3. Record the slice table (state on disk)

Append to the phase sub-plan, so a dead session resumes by grepping instead of re-deriving:

```markdown
## Slices

| id  | owns                     | depends | wave | status |
| --- | ------------------------ | ------- | ---- | ------ |
| 1a  | `src/auth/session*.ts`   | —       | 1    | TODO   |
| 1b  | `src/auth/tokens.ts`     | —       | 1    | TODO   |
| 2a  | `src/api/routes/auth.ts` | 1a,1b   | 2    | TODO   |
```

Status vocabulary is fixed and greppable, extending the ROADMAP's:
**`TODO` · `DISPATCHED` · `IN REVIEW` · `REVISING` · `DONE` · `BLOCKED`**.

Update it **in place** at every transition, in the same pass as the transition. A slice table that
lags the truth is worse than none.

## 4. Dispatch a wave — one message, one worker per slice

Send every slice in the wave as parallel `Agent` calls **in a single message**, each with
`subagent_type: task-worker` and `model: sonnet`. (No `task-worker` agent installed? Use
`general-purpose` with `model: sonnet` and paste the brief contract below inline.)

Mark the slices `DISPATCHED` before you send.

Each brief carries exactly:

> **Slice `<id>` — `<name>`.** Objective: `<the falsifiable done>`.
> You own **only** these paths: `<owns>`. Do not edit anything outside them.
> Context you need: `<the seam file(s) + the 2–3 files worth reading first>`.
> Steps: `<the ≤8 steps>`.
> Acceptance: run `<command>` and include its last ~10 lines in your report.
> Constraints: `<the architectural decisions from PLAN.md this slice must respect>`.
> Out-of-scope discoveries: report them, do not fix them.
> Reply with the REPORT format only — no diffs, no file dumps, no narration.

Never hand a worker the whole plan. It gets its slice, its seam, and its constraints.

## 5. Review the report, not the diff

Each worker returns a report: files touched (path + one line each), the acceptance command and its
output tail, decisions and deviations, and anything blocked or out of scope. Mark the slice
`IN REVIEW` and judge it against the brief:

- **Acceptance evidence present and passing?** No evidence, no approval — an unrun acceptance is a
  `REVISE`, always. This is the one rule that keeps review from decaying into rubber-stamping.
- **Deviations** — did it depart from the seam, the constraints, or the plan's architecture?
- **Ownership** — did it touch anything outside `owns`? Confirm cheaply:
  `git diff --name-only` (names, not content).
- **Spot-read only what's load-bearing** — the seam implementation, a security-relevant branch, the
  one hunk the brief called out. Read with `offset`/`limit`. A full diff read here forfeits the
  entire point of the skill.

Verdict, one per slice:

| Verdict     | When                                                                     | Next                                                       |
| ----------- | ------------------------------------------------------------------------ | ---------------------------------------------------------- |
| **APPROVE** | acceptance passes, no deviation that matters                             | slice → `DONE`                                             |
| **REVISE**  | fixable within the same slice                                            | §6                                                         |
| **RESLICE** | the slice was mis-specified (scope wrong, seam missing, two jobs in one) | slice → `BLOCKED`, rewrite the brief, redispatch next wave |

Out-of-scope discoveries a worker reported go to `/backlog-add` — not into this phase.

## 6. Revise in place, capped at 2 rounds

Send the fix back to **the same worker** via `SendMessage` with its agent ID: its context is intact,
so the fix costs a fraction of a cold respawn that re-reads everything. Mark the slice `REVISING`.
Name the specific defect and the acceptance to re-run — never "please improve this."

**Cap: 2 revise rounds.** A third failure is evidence the _brief_ was wrong, not that the model is
too weak. `RESLICE` it, or take that one slice in-context yourself. Escalating the worker's model is
the last resort, not the first.

(No `SendMessage` in your harness? Respawn with the original brief plus the defect list — and treat
the extra cost as another reason to keep the cap at 2.)

## 7. Close the wave

When every slice in the wave is `DONE` or `BLOCKED`:

1. **Verify what actually changed** — run `/verify-changed` if installed (it scopes to the changed
   packages plus dependents, off-context); otherwise the repo's verify on the touched packages.
2. **Update the slice table** in place.
3. **Then** open the next wave. Never dispatch wave N+1 with an unreviewed slice from wave N — that
   is precisely how the architecture drifts while you aren't looking.

A `BLOCKED` slice stops the phase: record why in the sub-plan and surface it to the user. `--auto`
does not override this.

## 8. Close the phase

All waves done → check the phase's own acceptance from the sub-plan, then update **both** the
sub-plan header and the `ROADMAP.md` line to `DONE (<date>)` in one pass, with a `## Log` entry.
This is `/plan-project`'s status-in-place discipline; orchestration doesn't get to skip it.

Then report to the user: slices run, what landed, the verify verdict, anything backlogged. **Stop
here** unless the invocation was `all --auto`, in which case continue to the next phase's §1.

At the end of the last phase, flip the ROADMAP header to `**Status:** DONE` and hand over the
per-phase acceptance checklist. `/ready` gives you that roll-up if it's installed.

## 9. Resume discipline

A session that dies mid-wave leaves the truth on disk:

```
grep -n 'DISPATCHED\|IN REVIEW\|REVISING\|BLOCKED' .claude/plans/<slug>/phase-*.md
```

Those slices' workers are gone — their edits are not. Check the working tree for what actually
landed (`git diff --name-only`), reconcile the table, and redispatch what's genuinely unfinished.
Never assume a `DISPATCHED` slice did nothing.

## Notes

- **What must never enter this context:** worker diffs, full file dumps, per-file logs, the match set
  of anything. If you're reading implementation here, you've stopped orchestrating and started
  working — either that's deliberate (a slice you took back) or it's the cost leak this skill exists
  to close.
- **Model policy:** you orchestrate at the session model; workers are `sonnet`; rote repo-wide edits
  aren't slices at all — send those to `/sweep` (haiku shards, count-only reports).
- **Worktree isolation** (`isolation: 'worktree'`) exists for waves that genuinely can't be made
  disjoint. Default to not using it: correct slicing is cheaper than merging, and needing it usually
  means §1 was done wrong.
- This skill executes plans; it does not make them. Design decisions belong in `/plan-project` and
  plan mode, where the user is in the loop.
