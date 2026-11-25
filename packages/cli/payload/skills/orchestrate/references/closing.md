# Closing a wave and a phase

Open this at a barrier or at phase close, when you are deciding what to snapshot and which of the
run's notes deserve a record. `SKILL.md` §7 and §8 carry the steps. This carries what each one is
protecting against.

## What the snapshot is for

The plan workspace is the whole reason a long run is resumable, and it is gitignored, so git is never
the fallback. Copy the plan directory plus any gitignored write-log, credential, or user-owned config
the tool directory carries. Skip everything the installer rewrites. It costs a second and it is the
only thing standing between a destructive slice and starting over.

Write it to one place: `${TMPDIR:-/tmp}/plan-snapshots/<repo-dir-name>/<slug>/<label>/`. The path sits
outside `.claude/`, because the snapshot guards against a slice that destroys the tool directory. It
also stays out of git status.

Every orchestrator at every depth uses the same two placeholders:

- `<slug>` is the plan's slug as `/orchestrate` takes it. A milestone member is
  `<milestone>/<member>`.
- `<label>` is `phase-<n>-wave-<k>` at a wave barrier and `phase-<n>-close` at phase close. At a
  milestone barrier it is `step-<step-slug>`, and the snapshot goes under the milestone slug.

A wave 1 barrier of phase 1 in member `device` of milestone `tetherbox-mvp` writes to
`.../tetherbox-mvp/device/phase-1-wave-1/`. The barrier of step `sign-up` writes to
`.../tetherbox-mvp/step-sign-up/`. No other nesting is valid.

## The diff budget at a wave close

A phase's diff has a budget, measured against the phase base. The base is the `Base:` line above
the slice table in the sub-plan's `## Slices` section, written once when the phase went
`IN PROGRESS`. A commit between waves does not reset the figure. Lock and generated files count like
any other file.

At every wave close, after the status table, run:

```
node .claude/scripts/diff-size.mjs --base <Base: sha> [--lines <n>] [--files <n>]
```

When the sub-plan header carries `**Budget:** <lines> lines, <files> files`, pass those values as
`--lines` and `--files`. Without it, the script's defaults apply, 600 lines and 50 files. Print its
one line under the status table.

- **Exit 0** is a clean wave. Go on without a pause.
- **Exit 1** means the phase passed a limit, and the run stops for the owner's ruling. Never open
  the next wave on an over-budget figure without that answer, under `--auto` too. In a nested run
  the phase-orchestrator returns `PHASE <slug>/<N>: NEEDS_RULING`, as `nested.md` says. In a flat
  run the dispatcher asks the owner. Both offer the same three options, in this order:
  1. Stop and commit what landed.
  2. Split the remaining steps into a new phase.
  3. Continue at a stated new budget of `<lines> lines, <files> files`.

  A new budget the owner states goes in the sub-plan's `## Notes & decisions`, and later wave
  closes in this phase pass it. The §8 UI-review condition never does.

- **Exit 2** prints no count, and stderr names the cause, such as a `Base:` sha that does not
  resolve. Print that message under the status table and surface it to the owner. Never pick a new
  base yourself.

## The commit command

At every wave close, print a commit command under the status table and go on without waiting:

```
git add <each path the wave's slices own>
git commit -m "<plan slug> phase <N> wave <n>"
```

Never run it yourself, at any depth. The owner commits, or does not.

At the next wave close, compare `git rev-parse HEAD` with the `Base:` sha and with the
`Committed: <short hash>` line under `Base:`. HEAD moved when it matches neither. Then print its
short hash on a line under the status table, and write that hash into the `Committed:` line in
place, adding the line under `Base:` the first time. The slice table gains no column for it.

## Why plan-lint runs at phase close

`node .claude/scripts/plan-lint.mjs` confirms the status update actually landed on both files. It has
caught real drift of exactly this shape: a ROADMAP line marked `DONE` while its sub-plan header still
read an earlier status.

## Review Focus at phase close

Before flipping the phase to DONE, read the sub-plan's `## Review Focus` section and confirm each
pinned test exists in the tree. A missing one is an unmet acceptance, so the phase stays open until
the test lands or the item is removed with a recorded reason.

## Promoting decisions and rulings

Run `/decide` on anything that clears its bar: not obvious from the code, a competent person could
have chosen otherwise, and re-deriving it costs real time. This proposes, it does not bulk-write.
Most notes and most deviations are not decisions. A worker deviation you accepted is a decision
candidate, because you approved a departure from the brief and nothing else in the tree records why.
A note that was decided and then reversed mid-phase graduates as two linked records: the original and
a `supersede` that replaces it, not one flattened summary.

A ruling from an `--auto` run is judged by that same bar. The difference is where it came from. A
decision was reasoned about with the user in the loop, and a ruling was made without them, so the
report has to state the cost if it was wrong even when the ruling is not durable enough to record.

## What a ruling is

A ruling is a judgment call you made mid-run that departed from the plan or filled a gap the plan left
open. Under `--auto` the transcript is the only place it lives, because the user was not there to be
asked. Listing it with a one-line cost if wrong, and recording the durable ones with `/decide`, puts
a ruling that outlives the phase on disk instead of in a report read once.

A ruling that removes behavior is never reported under `Rulings made`. It goes under
`Removed beyond plan`, which forces `NEEDS_RULING`, because a ruling listed with a cost if wrong is
read once and never answered.

## Why `/clear` beats `/compact` at the context-size gate

The plan docs are the state, so a compaction summary of them is redundant. `/clear` is cheaper than
`/compact`, then `/orchestrate <slug> <next-phase>` resumes from disk. Under `all --auto` the stop
prints `/clear` and then `/orchestrate <slug> all --auto`. `--ignore-gates context-size` is for a run
whose owner accepts unbounded context growth.

## Resume after a dead session

Run `grep -n 'DISPATCHED\|IN REVIEW\|REVISING\|BLOCKED' .claude/plans/<slug>/phase-*.md`. The
slices it lists have no workers left, but their edits landed in the tree, so compare the table against
`git diff --name-only` before redispatching.

## A stalled close-of-phase review

`/accessibility-review`, `/design-review`, and the decision reviewer are subagents, so they can stall
like a worker (a report containing the word "stalled"). Re-dispatch the review once. If it stalls
again, run the deterministic checker in-context and report the judgment tier as not run, so the user
knows that half of the review never happened.

## The PR description

`/pr-description` hands the text over. The user still creates the PR.

## Workflows and ultracode

`/orchestrate` starts no Workflow. When the Workflow tool or ultracode is on, the §5 to §8 gates
are the review, so no review workflow runs between phases. The §8 `/accessibility-review` and
`/design-review` still run, because a "no extra reviews" memory does not cover them. When the user
asks for a workflow, every agent in it names an installed agent type or an explicit `model`. The
gates already review the same diff, and a bare workflow agent inherits the session model and
effort, which under ultracode means a full-effort Opus agent per reviewer.
