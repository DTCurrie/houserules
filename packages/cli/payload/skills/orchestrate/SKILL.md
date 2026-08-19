---
name: orchestrate
description: Execute a planned phase by fanning out task-worker subagents per file-owned slice, then review each worker's report. Use to drive a .claude/plans/ phase to done.
argument-hint: '[<plan-slug>] [<phase> | all] [--auto]'
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, Agent, SendMessage
---

Drive planned work to done as **planner → orchestrator → reviewer**: **$ARGUMENTS**

You stay expensive and small. The implementation happens in cheap, tightly-scoped `task-worker`
subagents, and what comes back to you is a **report**, not a diff. Your context holds the plan, the
seam, and N one-screen reports. It never holds the code the workers wrote.

**The economy, stated once:** you pay `O(slices × report)` plus the seam you write yourself. A worker
that reads twelve files and writes six pays for that itself, in a context that dies when its slice
does. That is also the anti-rot argument, because no worker accumulates the other slices' history.

## 0. Preconditions and arguments

This skill executes a **plan that already exists**. List the candidates with their live status:

```
grep -l . .claude/plans/*/ROADMAP.md | xargs grep -H '^\*\*Status:\*\*'
```

- **No plan workspace?** Stop and run `/plan-project "<what to build>"` first (the `plans` module).
  Orchestration without a persisted phase boundary has nothing to slice and nowhere to record status.
- **Trivial work?** If the phase is a handful of files you'd finish in one pass, **do it yourself**.
  Briefs, dispatch, and review cost more than the work below roughly two slices.

### Arguments

`/orchestrate [<plan-slug>] [<phase> | all] [--auto]`, both leading parts optional. A bare token that
is a number or `all` is the **phase**. Anything else is the **plan slug**.

| Invocation                     | Means                                                   |
| ------------------------------ | ------------------------------------------------------- |
| `/orchestrate`                 | resolved plan (below), its live phase                   |
| `/orchestrate auth-rework`     | that plan, its live phase                               |
| `/orchestrate 3`               | resolved plan, phase 3                                  |
| `/orchestrate auth-rework all` | that plan, every remaining phase, check-in between each |
| `… all --auto`                 | same, without the inter-phase check-in                  |

**Live phase** is the one marked `IN PROGRESS` in that plan's `ROADMAP.md`. If none is marked, take
the first `TODO`.

### Resolving which plan

No slug given? In order:

1. **One workspace under `.claude/plans/`** → that's it. (Ignore `blast-radius-*` impact maps. They
   are archives, not plans.)
2. **The conversation names one.** The user just planned it, or you're resuming work you were already
   doing on it. Use it, and **say which one you picked** in your first line of output.
3. **Exactly one has `Status: IN PROGRESS`** → that one.
4. **Otherwise ask.** Two half-finished plans is precisely when guessing wrong is expensive. List the
   slugs with their status lines and let the user pick.

Never infer a plan from mtime or from which directory sorts first. State the resolved plan and phase
before you slice anything. That one line is what lets the user stop you cheaply if you picked wrong.

**Default is check-in.** After each phase closes, report what landed and stop for the user. `--auto`
suppresses only that pause. It never suppresses a `BLOCKED` stop (§7).

## 1. Slice the phase

Read the phase sub-plan (`phase-N-<slug>.md`). Break its steps into **slices**: the unit one worker
owns end to end.

A well-formed slice has:

- **`owns`:** the exact paths/globs that worker may write. Nothing outside them.
- **a falsifiable done:** a command at its narrowest form, e.g. `vitest run <file>`, reachable as
  `pnpm --filter <pkg> test <path/to/file.test.ts>`.
- **a brief that fits on one screen.** If it needs more than ~8 steps or touches more than ~6 files,
  split it.
- **both bounds on a numeric or set-valued criterion.** A cap alone lets a worker satisfy the letter
  with a degenerate answer, like one token used once.
- **a named source for a criterion over observed values.** Without it, a browser's own defaults count
  as violations too. Both are brief-authoring defects: fix the brief, not the model.

**Reconcile the phase's acceptance against the slices', before you dispatch.** Read the sub-plan's own
"done when" list and check each criterion against the union of the slice acceptances you just wrote.
Assign every orphan to the slice that owns the code it covers, and add it to that brief's steps. Every
slice can pass its own acceptance while the phase quietly fails its own, because a slice is scoped by
file ownership and an acceptance criterion is not. A criterion no slice tests is one you write
yourself at the barrier, in the most expensive context available, after the cheap workers with the
right files already open have finished and gone. §8 checks the same list at phase close, and that is
the backstop rather than the plan.

**A whole-suite run is not a valid slice acceptance.** Workers in a wave run in parallel, so when one
runs its acceptance its siblings are mid-edit. A red full suite there says nothing about the slice,
and it pushes the worker to either report a spurious `BLOCKED` or reach outside its owned paths to
fix a sibling's half-written file. Repo-wide verification is the wave barrier's job (§7), where the
tree is quiet.

**A green test run is not a green typecheck.** Most JS runners (vitest, bun, jest through babel) strip
types rather than check them, so a slice passes its named test file and still fails the repo's `tsc` at
the barrier. Where the repo typechecks as a separate step, give the slice both commands: the behavior
check on the owned tests, and the typecheck on the owned project. The barrier catches this either way.
It catches it after the wave closed, which costs a residue pass instead of the worker's own retry.

Two commands is the ceiling, not a starting point. Each one a slice carries is paid by every worker
in the wave at once, so a package-wide typecheck handed to four slices is four package-wide
typechecks. Prefer the narrowest command that could actually fail on this slice's changes.

**The acceptance has to be cheap enough to iterate against, because iterating is what it is for.** A
worker runs it, fixes what is red, and runs it again until it goes green. Hand it a command too slow
or too broad for that loop and it will quietly stand up a narrower proxy, iterate against that, then
run your acceptance at the end as a formality. That is two runs where you asked for one, and a green
proxy proves nothing about the command you actually named. Narrow the acceptance until it can carry
the loop. Never word the brief so the acceptance reads as a closing ceremony.

**Pair the typecheck in only when its project is quiet.** `tsc` runs per project, not per file, so a
package-scoped typecheck reads whatever a sibling is mid-write in that package, which is the same
failure as the whole-suite run above. Slices in disjoint packages can each carry their own, and that
is a reason to prefer slicing along package or tsconfig-project boundaries where the phase allows it.
When slices in one wave share a project, leave the typecheck at the barrier and **say so in the
brief**, so a worker does not add it back on its own.

**File ownership is the parallelism constraint, not conceptual independence.** Two slices may run in
the same wave **iff their `owns` sets are disjoint**. Two "unrelated" features that both edit a barrel
export are not parallel. They serialize, or one of them gives that file up.

**A slice owns the tests that assert its files' behavior, or it cannot finish.** If a slice changes
`plan.ts`, it owns `plan.test.ts`. If it changes a warning string, it owns the suite asserting that
string. Get this wrong and you get one of two failures, both of which surface at the barrier in the
most expensive context you have: the worker ships a fix with no regression test, because the only
valid home was outside its `owns`, or it breaks a sibling's assertion and correctly declines to
repair it. Walk each slice's file list and ask what currently asserts these bytes.

**A slice judged against a spec carries that spec, by path.** When the plan records a format, a
standard, or a criteria doc that a slice's output has to conform to, name it on the brief's
`Reference` line. "Never hand a worker the whole plan" means the plan, not the one document the slice
is measured by. A worker left to infer a format invents one, and that surfaces at the barrier, in the
most expensive context you have, after the worker who could have gotten it right is gone.

**Slice by shared mutable resource, not by feature.** File ownership is the usual expression of
this, but it is not the only resource two slices can contend for. Before a wave, name everything two
slices might both write, then draw the slices so each one is owned once:

- a repo-wide formatter or fixer, which rewrites files nobody assigned it
- generated tool directories, especially gitignored ones nothing can restore
- append-only logs and ledgers, where a write inside an isolated worktree is silently discarded
  rather than conflicted
- a package's build output, when two slices in that package both need to build

**Lanes, when a resource cannot be partitioned.** Work whose SUBJECT is one of those shared
resources does not belong in the main checkout beside slices that merely read it. Give it a lane: a
worktree on its own branch, or a checkout pinned at HEAD for read-only falsification. Two costs to
plan for. A worktree needs its own dependency install, and **it carries none of the tool directory**,
so a lane worker cannot be pointed at a brief by path and cannot capture a baseline that assumes an
installed tree. Give a lane worker its brief inline.

**Slices in one wave may come from different plans.** Nothing here requires a wave's slices to share
a phase, or even a project. When several plans are in flight, drawing waves across all of them by
the resource rule above is what finds the real parallelism, and it is usually much wider than any
single plan's phase boundaries suggest. Record which plan each slice came from, and update BOTH that
plan's status and the wave's when it lands.

**When you drop a slice, re-home its scope.** A slice canceled mid-program usually carried more
than the reason it was canceled for. Read its brief before deleting it and move whatever is still
wanted into another slice, or you will rediscover the orphaned half several slices later.

**Orchestrator-owned files** never appear in any worker's `owns`: lockfiles, generated indexes,
barrel/export files, shared type modules, migrations, config. You edit those (§2). Workers that need a
change there **request it in their report**. They don't reach for it.

## 2. Write the seam yourself — before any fan-out

Contract-first is what makes parallel slices safe. Before dispatching a wave, **you** write the shared
surface it depends on: interfaces, type signatures, function stubs, config keys, the migration, the
route table. Small, high-leverage, and exactly the judgment you're the expensive model for.

Commit it to disk before fanning out. Workers then implement **against a fixed seam** instead of
guessing at each other's shapes, which is the failure that makes parallel agent work produce
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

`.claude/scripts/plan-lint.mjs`, if installed, checks a status cell against this exact vocabulary
and cross-checks the ROADMAP line against the sub-plan header it links to. Run
`node .claude/scripts/plan-lint.mjs` after writing or updating the table, so a typo'd status does
not silently break the resume grep in §9.

## 4. Dispatch a wave — one message, one worker per slice

Send every slice in the wave as parallel `Agent` calls **in a single message**, each with
`subagent_type: task-worker` and `model: sonnet`. (No `task-worker` agent installed? Use
`general-purpose` with `model: sonnet` and paste `agents/task-worker.md` inline, ahead of the brief.)

Mark the slices `DISPATCHED` before you send.

`task-worker.md` carries the standing rules. Each brief adds only what's specific to this slice,
and **never restates or overrides a standing rule**. A brief that contradicts one silently disarms
it, and the only thing standing between that and a corrupted wave is a worker with the judgment to
refuse.

The one most often violated is the fixer prohibition. `task-worker.md` says a worker does not run
lint, format, or fix commands, because a fixer rewrites files its siblings still have open. A
verification recipe written for in-context work says the opposite, and copying that recipe into a
brief is the easiest mistake in this skill. **The fixer runs once, at the barrier (§7), and never
in a worker.**

> **Slice `<id>` — `<name>`.** Objective: `<the falsifiable done>`.
> You own **only** these paths: `<owns>`. Do not edit anything outside them.
> Context you need: `<the seam file(s) + the 2–3 files worth reading first>`.
> Reference: `<the plan doc(s) this slice's output is judged against, by path, or "none">`.
> Steps: `<the ≤8 steps>`.
> Acceptance: `<command(s), scoped to your owned paths>` is your iteration loop. Run it, fix what is
> red, run it again, and stop the moment it goes green. Include the last ~10 lines of each in your
> report.
> Constraints: `<the architectural decisions from PLAN.md this slice must respect>`.

Never hand a worker the whole plan. It gets its slice, its seam, and its constraints.

### The status table — the one shape you print between waves

The slice table (§3) is state on disk. This is its user-facing projection. Emit it **once when the
wave goes out and once when it closes**, and nowhere else. Same three columns, every run:

```markdown
| Slice            | Owns                     | State      |
| ---------------- | ------------------------ | ---------- |
| 1a session store | `src/auth/session*.ts`   | ✅ done    |
| 1b token codec   | `src/auth/tokens.ts`     | 🔄 running |
| 2a route wiring  | `src/api/routes/auth.ts` | ⬜ pending |
```

Every slice in the phase appears in every printing, including the waves that haven't opened yet.
Progress is only legible against the whole, and a table that shows only the live wave hides how much
is left.

Collapse the on-disk vocabulary into four display states, so the table stays scannable while the
sub-plan stays greppable:

| On disk                             | Prints as    |
| ----------------------------------- | ------------ |
| `DONE`                              | `✅ done`    |
| `DISPATCHED` `IN REVIEW` `REVISING` | `🔄 running` |
| `TODO`                              | `⬜ pending` |
| `BLOCKED`                           | `⛔ blocked` |

No prose duplicating the table. One line under it for anything the columns can't carry (a blocked
slice's reason, a revise round in flight), then move on.

**Formatting is orchestrator work, not worker work.** A fixer run by one worker rewrites files its
siblings still hold open, so the edits collide and N workers redo the same whole-repo pass N times.
One run at the wave barrier (§7) is cleaner and cheaper. If houserules' `lint-fix` module is installed,
confirm `fix.onSubagentStop` is not `true` in `.claude/houserules.config.json`. That setting fires the fixer
at every worker's exit, which is exactly the collision above.

**That setting covers only half of it.** `fix.onSubagentStop` governs a WORKER's exit. A `Stop` hook
fires at YOUR exit, and this pattern ends a turn every time you dispatch or review, with every
worker still holding files open. So the repo-wide fixer runs against a tree mid-edit anyway, from the
other direction.

Two consequences, and the second one matters more:

- Expect a fixer or linter to report problems in files a live slice is halfway through. A worker that
  has added an import and not yet written the call is not a defect.
- **A lint or format finding inside a `DISPATCHED` slice's owned path is not residue, and you do not
  act on it.** Check the slice table before touching anything a hook names. Fixing it means editing a
  running worker's file, which is precisely what every ownership rule here exists to prevent. Residue
  is only what survives the barrier, when every slice is `DONE` or `BLOCKED` and the tree is quiet.

## 5. Review the report, not the diff

**Check the tree before you read the report.** The report is the worker's claim about what it did.
The tree is what it did. Run this first, every slice, before forming any opinion:

```
git status --short | grep '^ T\|^T '   # typechanges: a file replaced by a symlink
git status --short | grep '^ D\|^D '   # deletions: every one must be intentional
ls .claude/plans/<slug>/               # plan state still there
```

Seconds to run. Destruction is what reports are worst at surfacing, because a worker that deleted
something usually did it in service of a step that then succeeded, so its acceptance is green and its
summary is accurate as far as it goes. A typechange means a real file became a symlink, which is
almost never intended. A deletion outside `owns` is a defect regardless of what the report says about
it. If plan state is gone, stop the wave and recover before anything else.

Each worker returns a report: files touched (path + one line each), the acceptance command and its
output tail, decisions and deviations, and anything blocked or out of scope. Mark the slice
`IN REVIEW` and judge it against the brief:

- **Acceptance evidence present and passing?** No evidence, no approval. An unrun acceptance is a
  `REVISE`, always. This is the one rule that keeps review from decaying into rubber-stamping. A brief
  with two commands needs two tails. A test tail alone, where you also asked for a typecheck, is an
  unrun acceptance.
- **Did the acceptance actually RUN, or did the build system skip it?** An incremental runner
  (wireit, turbo, nx, bazel) reports a cache hit as success. `Ran 0 scripts and skipped 26` is a
  claim that a previous run with these inputs passed, not evidence that anything ran now. That is
  usually fine and is the reason the cache exists. It is not fine as the sole evidence for a slice
  that changed a dozen files, and it is worthless when the worker populated the cache itself moments
  earlier. When a tail shows everything skipped on a large slice, verify one thing yourself directly.
- **Could the evidence have come out any other way?** An observed value is evidence only if a broken
  implementation would have produced a different one. One worker mirrored a route across the wrong
  axis and confirmed it by reading the Z column back, but the fixture sat at z ≈ 0, where negating
  changes nothing, so correct and broken produce the same output. The report was accurate and carried
  no information. Where the acceptance is a value read rather than a command's exit code, ask what
  the reading would have been if the code were wrong. If the worker did not say, send it back.
- **Did it satisfy the letter and worsen the artifact?** A worker optimizes for the acceptance you
  wrote. Ask what the change does to the shipped thing, not just to the check. One slice satisfied
  "the tarball must not carry these files" by excluding them in `files` while leaving a package
  `exports` entry pointing at them, which passes the check and publishes a package resolving to
  nothing.
- **Deviations.** Did it depart from the seam, the constraints, or the plan's architecture?
- **Ownership.** Did it touch anything outside `owns`? Confirm cheaply with
  `git diff --name-only` (names, not content).
- **Spot-read only what's load-bearing:** the seam implementation, a security-relevant branch, the one
  hunk the brief called out. Read with `offset`/`limit`. A full diff read here forfeits the entire
  point of the skill.

Verdict, one per slice:

| Verdict     | When                                                                     | Next                                                       |
| ----------- | ------------------------------------------------------------------------ | ---------------------------------------------------------- |
| **APPROVE** | acceptance passes, no deviation that matters                             | slice → `DONE`                                             |
| **REVISE**  | fixable within the same slice                                            | §6                                                         |
| **RESLICE** | the slice was mis-specified (scope wrong, seam missing, two jobs in one) | slice → `BLOCKED`, rewrite the brief, redispatch next wave |

Out-of-scope discoveries a worker reported go to `/backlog-add`, not into this phase.

## 6. Revise in place, capped at 2 rounds

Send the fix back to **the same worker** via `SendMessage` with its agent ID. Its context is intact,
so the fix costs a fraction of a cold respawn that re-reads everything. Mark the slice `REVISING`.
Name the specific defect and the acceptance to re-run, never "please improve this."

**Cap: 2 revise rounds.** A third failure is evidence the _brief_ was wrong, not that the model is too
weak. `RESLICE` it, or take that one slice in-context yourself. Escalating the worker's model is the
last resort, not the first.

(No `SendMessage` in your harness? Respawn with the original brief plus the defect list, and treat the
extra cost as another reason to keep the cap at 2.)

## 7. Close the wave

Every slice reviewed (`DONE` or `BLOCKED`), and only then. This is the wave **barrier**, the one point
where the tree is quiet enough to touch globally:

1. **Fix once.** Run the repo's auto-fix (`lint:fix` / `format:fix`, or the `fix.commands` in
   `.claude/houserules.config.json`) across the packages the wave touched. One run, after the fan-out has
   settled. Nothing was formatting mid-flight, so this is the first pass over a consistent tree.
2. **Verify what actually changed.** Run `/verify-changed` if installed (it scopes to the changed
   packages plus dependents, off-context), otherwise the repo's verify on the touched packages.
3. **Update the slice table** in place, then print the status table (§4), the wave-close printing.
4. **Snapshot the state nothing can regenerate**, into a scratch directory. The plan workspace is the
   whole reason a long run is resumable, and it is gitignored, so git is never the fallback. Copy the
   plan directory plus any gitignored write-log, credential, or user-owned config the tool directory
   carries. Skip everything the installer rewrites. It costs a second and it is the only thing
   standing between a destructive slice and starting over.
5. **Then** open the next wave. Never dispatch wave N+1 with an unreviewed slice from wave N. That is
   precisely how the architecture drifts while you aren't looking.

**Residue** is what auto-fix couldn't fix, and it's yours by default. It's usually a handful of lines,
and a brief costs more than the edit. Delegate only when it's genuinely bulk work:

| Residue                                             | Do                                                                                           |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| ≤ ~5 files, or any of it needs judgment             | fix in-context yourself                                                                      |
| Many files, **one** rule (a rename, an import swap) | `/sweep` (haiku shards, count-only reports)                                                  |
| Many files, several mechanical rules                | one cleanup `task-worker` owning exactly those paths, with the fix command as its acceptance |

Never send residue back to the slice workers. Their briefs are spent, and the residue crosses slice
boundaries by definition. That's why it survived to the barrier.

A `BLOCKED` slice stops the phase. Record why in the sub-plan and surface it to the user. `--auto`
does not override this.

## 8. Close the phase

All waves done → check the phase's own acceptance from the sub-plan, then update **both** the sub-plan
header and the `ROADMAP.md` line to `DONE (<date>)` in one pass, with a `## Log` entry. This is
`/plan-project`'s status-in-place discipline, and orchestration doesn't get to skip it.

Run `node .claude/scripts/plan-lint.mjs` if installed, to confirm the update actually landed on
both files. It has caught real drift of exactly this shape: a ROADMAP line marked `DONE` while
its sub-plan header still read an earlier status.

**Before reporting, promote durable decisions.** Skip this step if `.claude/scripts/decision-log.mjs`
is absent. Re-read the phase's `## Notes & decisions` and the decisions-and-deviations section of
every report you reconciled. Run `/decide` on anything that clears its bar: not obvious from the
code, a competent person could have chosen otherwise, and re-deriving it costs real time. This
proposes, it does not bulk-write. Most notes and most deviations are not decisions. A worker
deviation you accepted is a decision candidate, because you approved a departure from the brief and
nothing else in the tree records why. A note that was decided and then reversed mid-phase graduates
as two linked records: the original and a `supersede` that replaces it, not one flattened summary.

Then report to the user: slices run, what landed, the verify verdict, anything backlogged. **Stop
here** unless the invocation was `all --auto`, in which case continue to the next phase's §1.

At the end of the last phase, flip the ROADMAP header to `**Status:** DONE` and hand over the
per-phase acceptance checklist. `/ready` gives you that roll-up if it's installed.

## 9. Resume discipline

A session that dies mid-wave leaves the truth on disk:

```
grep -n 'DISPATCHED\|IN REVIEW\|REVISING\|BLOCKED' .claude/plans/<slug>/phase-*.md
```

Those slices' workers are gone. Their edits are not. Check the working tree for what actually landed
(`git diff --name-only`), reconcile the table, and redispatch what's genuinely unfinished. Never
assume a `DISPATCHED` slice did nothing.

## Notes

- **What must never enter this context:** worker diffs, full file dumps, per-file logs, the match set
  of anything. If you're reading implementation here, you've stopped orchestrating and started
  working.
- **Worktree isolation** (`isolation: 'worktree'`) exists for waves that genuinely can't be made
  disjoint. Default to not using it. Correct slicing is cheaper than merging, and needing it usually
  means §1 was done wrong.
- This skill executes plans. It does not make them. Design decisions belong in `/plan-project` and
  plan mode, where the user is in the loop.
