# Dispatching workers directly

Open this when the main conversation holds work for a few workers and no plan workspace. Direct
dispatch sends `task-worker` subagents from the main conversation itself, with no
`phase-orchestrator` between them. It skips the plan workspace and the nested relay, and keeps the
checks that make a worker's report safe to believe: the tree check, the review, and the barrier.

## When it applies

Direct dispatch applies when all three of these hold:

- The work splits into two or more slices. Below two, do the work in context, as `SKILL.md` §0
  says.
- Each slice's `owns` set is disjoint from every other slice's, with no path or glob in two lists.
- Each slice has a falsifiable done, a command at its narrowest form, as `SKILL.md` §1 defines it.

No plan workspace is needed. The slice table lives in the conversation, printed as the status
table in `SKILL.md` §4, once when the workers go out and once when they close.

## How many go out at once

Run `node .claude/scripts/wave-ceiling.mjs` before the dispatch and read `ceiling` and `share` from
its JSON line, as `references/slicing.md` "Wave ceiling" says. Send up to `ceiling` workers in one
message. Past it, send the first batch, close it at the barrier below, then send the next. Prefix
each acceptance command with the share as that section defines it. The script's number is the
count, so read it every time and never carry one from an earlier run.

The ceiling bounds how many workers run at once. It says nothing about how many reports the main
conversation holds in total, and this file sets no total.

## The brief

Each worker gets the brief template in `SKILL.md` §4, filled for its slice, with the same
`subagent_type`, `model`, and `effort` rules from `references/slicing.md`. The brief carries the
slice, its owned paths, the context to read, its acceptance with the share prefix, and its
constraints. It never restates a standing rule from `task-worker.md`.

## The tree check

Before reading each report, run the three commands in `SKILL.md` §5 and `git diff --name-only`
against the slice's `owns`. A deletion or a write outside `owns` is a defect, whatever the report
says. Then judge the report against its brief by §5's checks and give it one verdict. A `REVISE`
goes back to the same worker by `SendMessage`, as §6 says.

## The barrier

When every worker in the batch has reported and each slice is approved, run `SKILL.md` §7 steps 1
to 3 over the packages the batch touched: the fixer once, `/tidy` once, then each slice's
acceptance again and a typecheck. After the last batch, run `/verify-changed` once, as §8 says, and
report what landed with the verify verdict.

## When to hand the work to /orchestrate

Stop direct dispatch and plan the work with `/plan-project`, then run it with `/orchestrate`, when
the main conversation observes any of these:

- Two slices list the same path or glob in `owns`, or the tree check shows a worker wrote a path
  another slice owns.
- A slice's first `REVISE` came back with its acceptance still failing, so a second round would
  start.
