---
name: plan
description: Plan and drive a large, multi-phase implementation as a persisted project — scaffold a gitignored `.claude/plans/<name>/` workspace (a PLAN overview, a living ROADMAP, one sub-plan per phase), then keep ROADMAP status current in place as each phase lands so a returning session greps status instead of re-deriving scope from the transcript. Use when a task is too big to hold in one in-context plan.
argument-hint: <what to build>
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, Agent
---

Plan and drive a multi-phase implementation as a project: **$ARGUMENTS**

The discipline that makes this cheaper than re-planning from scratch each session: the plan lives
on disk, not in the transcript, and **`ROADMAP.md` is the single source of truth for what's done**.
Every phase updates its status _in place_ the moment it lands, so resuming is a grep — never a
re-derivation from scrollback.

## 0. Is this big enough to persist?

A persisted plan earns its keep only for work that outlives one sitting. Scaffold **only** when at
least one holds:

- **3+ distinct phases** that can land independently and each leave the tree working.
- Work you expect to **pause and resume** across sessions or days.
- Enough moving parts that "what's left?" won't be obvious from `git diff` alone.

If it's a handful of files you'll finish now, **stop — plan it inline** (or use plan mode) and
scaffold nothing. A `.claude/plans/` dir for a one-sitting task is pure overhead. When it's a
genuine toss-up, ask the user whether to track it as a project.

## 1. Name the plan and scaffold the workspace

Pick a short kebab slug for the effort (e.g. `auth-rework`, `payments-v2`). Stamp the date once so
the docs are dateable on resume:

```
date +%Y-%m-%d
```

Create the workspace directory (the kit already installed `.claude/plans/.gitignore`):

```
mkdir -p .claude/plans/<slug>
```

Everything under `.claude/plans/` is **gitignored by default** — it's your living project state, not
a commit artifact, and it churns every phase. (To share a plan with the team, `git add -f` it or
delete `.claude/plans/.gitignore`.)

## 2. Design the phases

Break the work into **coarse phases** — 2–6 is typical. If you have a dozen, you're listing steps,
not phases. Each phase must:

- land independently and leave the tree in a working state, and
- have a **falsifiable "done"** — the acceptance you could actually check (a test passes, a route
  returns 200, a flag flips).

Ground the phases in the real code, not guesses. Read the repo's own docs + targeted greps first;
if a subsystem is unfamiliar, fan out **one read-only Explore subagent** to map its seams before you
commit to a phase boundary (fan out only for what the docs and greps don't answer). For the design
thinking itself, plan mode and the Plan agent are available — this skill's job is to **persist** the
result, not to replace them.

## 3. Write the three doc types

Create these under `.claude/plans/<slug>/`. Keep each lean and cross-linked; relative links so the
workspace is self-contained.

**`PLAN.md`** — the stable overview (goal + approach; rarely changes once set):

```markdown
# PLAN — <slug>

**Created:** <date> · **Status:** see [ROADMAP.md](ROADMAP.md)

## Goal

<One paragraph: what we're building and why. The problem, not the steps.>

## Approach

<The high-level strategy: key decisions, constraints, explicit non-goals.>

## Phases

1. **<name>** — <one line> → [phase-1-<slug>.md](phase-1-<slug>.md)
2. **<name>** — <one line> → [phase-2-<slug>.md](phase-2-<slug>.md)

## Key files & interfaces

<The load-bearing files/APIs this work touches — where a resuming session should look first.>
```

**`ROADMAP.md`** — the **living** status doc; the one file resume reads first:

```markdown
# ROADMAP — <slug>

**Status:** IN PROGRESS · **Started:** <date> · **Updated:** <date>

> Resuming? Read this file's status lines below — do not re-derive scope from the transcript.

## Phases

- [x] **Phase 1 — <name>** · Status: DONE (<date>) · [sub-plan](phase-1-<slug>.md)
- [~] **Phase 2 — <name>** · Status: IN PROGRESS · [sub-plan](phase-2-<slug>.md)
- [ ] **Phase 3 — <name>** · Status: TODO · [sub-plan](phase-3-<slug>.md)

## Log

- <date> — <one line on what changed / what's next>
```

Status vocabulary is fixed so it's greppable: **`TODO` · `IN PROGRESS` · `DONE` · `BLOCKED`**.
Checkboxes mirror it: `[ ]` todo, `[~]` in progress, `[x]` done.

**`phase-N-<slug>.md`** — one per phase, the working record for that slice:

```markdown
# Phase N — <name>

**Status:** TODO · **Part of:** [PLAN.md](PLAN.md) · **Roadmap:** [ROADMAP.md](ROADMAP.md)

## Objective

<What "done" means here — the falsifiable acceptance from step 2.>

## Steps

- [ ] <step>
- [ ] <step>

## Notes & decisions

<Captured as you implement: what you chose, what you ruled out, surprises. This is the durable
memory that survives the transcript.>
```

## 4. Implement phase by phase

Work one phase at a time, top of the ROADMAP down. Before starting a phase, set its ROADMAP line and
sub-plan header to `IN PROGRESS`. Do the work; tick the sub-plan's step checkboxes as you go. Don't
smuggle a later phase's work into the current one — the point is that each phase lands cleanly.

## 5. Keep ROADMAP the source of truth (status in place)

The instant a phase lands (its acceptance actually passes), update **both** the ROADMAP line
(`[x]` / `Status: DONE (<date>)`) and the sub-plan header — in the same edit pass, before moving on.
A stale ROADMAP is worse than none: it lies to the next session. Add a one-line `## Log` entry with
the date and what's next. Bump the `**Updated:**` date. If a phase is blocked, mark it `BLOCKED` and
note why in the sub-plan — don't leave it silently `IN PROGRESS`.

When the plan itself changes (a phase splits, drops, or reorders), edit PLAN.md and ROADMAP.md to
match reality. The docs track what you're _actually_ doing, not the original guess.

## 6. Resume discipline

Returning to this work (new session, or after a detour)? **Read `ROADMAP.md` first** — its status
lines are the current scope. Grep for the live phase instead of reconstructing state from scrollback:

```
grep -n 'Status: IN PROGRESS\|Status: BLOCKED' .claude/plans/<slug>/ROADMAP.md
```

Open the matching sub-plan for its steps and notes, then continue. Only fall back to reading the diff
or transcript for detail the docs don't capture.

## 7. Finishing

When every phase is `DONE`: flip the ROADMAP header to `**Status:** DONE`, add a final `## Log`
line, and give the user the acceptance checklist (the per-phase "done" criteria, now checkable). The
workspace stays on disk as the project's record — it's gitignored, so it never enters a commit. If
the user wants the plan gone, delete `.claude/plans/<slug>/` (leave `.claude/plans/.gitignore`).
