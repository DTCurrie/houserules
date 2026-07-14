---
name: review-change
description: Dispatch the per-target reviewer agents for a change — map the changed files to each area's ${name}-reviewer (by the kit.config.json pathPrefix), fan them out in ONE message as read-only agents, and reconcile their OK / Conflict / Gap verdicts. Use to review a working-tree or branch change against each area's authoritative source before handing off.
allowed-tools: Bash, Read, Agent
---

Review the current change by dispatching the **per-target reviewer agents** the kit ships — one
read-only auditor per area, each checking the change against that area's authoritative source.

## 1. Find the changed areas

```
git diff --name-only
```

(Reviewing a branch, not just the working tree? Use `git diff --name-only <base>...HEAD`, base =
the changesets `baseBranch`.)

## 2. Map changed paths → reviewers

Read `.claude/kit.config.json`. Each entry in `targets[]` has a `pathPrefix` and a `name`; the
matching reviewer agent is `${name}-reviewer` (installed at `.claude/agents/${name}-reviewer.md`).
For each changed file, find the target whose `pathPrefix` it falls under (longest prefix wins), and
collect the set of `${name}-reviewer` agents whose area was touched. Skip a target with no
`*-reviewer.md` agent on disk (note it as an unreviewed area).

## 3. Fan out — one message, read-only

Dispatch every matched reviewer in a **single message** (parallel `Agent` calls), each scoped to its
own area's changed files. They are read-only by construction. Give each agent: the change under
review (the diff for its files) and the instruction to return one verdict per its own contract —
**OK** | **Conflict** (quote the rule + the conflicting code) | **Gap** (source silent).

Do not review the code yourself here — the reviewers own the authoritative sources. Your job is the
dispatch and the reconcile.

## 4. Reconcile

Collect the verdicts into one table: area → OK / Conflict / Gap (+ the one-line reason). Then:

- **Any Conflict** → the change violates an authoritative rule. Surface it with the quote; fix or
  flag before handoff.
- **Gap** → the source is silent; note it as a judgment call for the user.
- **All OK** → say the change is consistent with every touched area's source of truth.

## Notes

- Reviewer agents ship as **DRAFTs** (`npx claude-kit modules --modules=reviewers`); each needs its
  authoritative source filled in before its verdict means anything. `npx claude-kit doctor` flags any
  still-DRAFT reviewer. A DRAFT reviewer's verdict is not trustworthy — treat it as unreviewed.
- This dispatches reviewers; it does not run tests. For scoped verification, use `/verify-changed`.
