---
name: review-change
description: Dispatch the per-target reviewer agents for a change, mapped by houserules.config.json pathPrefix, and reconcile their OK / Conflict / Gap verdicts. Use to review a working-tree or branch change before handing off.
allowed-tools: Bash, Read, Agent
---

Review the current change by dispatching the **per-target reviewer agents** houserules ships: one
read-only auditor per area, each checking the change against that area's authoritative source.

## 1. Find the changed areas

```
git diff --name-only
```

Reviewing a branch rather than just the working tree? Use `git diff --name-only <base>...HEAD`, where
base is the changesets `baseBranch`.

## 2. Map changed paths → reviewers

Read `.claude/houserules.config.json`. Each entry in `targets[]` has a `pathPrefix` and a `name`, and the
matching reviewer agent is `${name}-reviewer`, installed at `.claude/agents/${name}-reviewer.md`.
For each changed file, find the target whose `pathPrefix` it falls under, longest prefix wins, and
collect the set of `${name}-reviewer` agents whose area was touched. Skip a target with no
`*-reviewer.md` agent on disk, and note it as an unreviewed area.

## 3. Fan out — one message, read-only

Dispatch every matched reviewer in a **single message** as parallel `Agent` calls, each scoped to its
own area's changed files. They are read-only by construction. Give each agent the change under review,
meaning the diff for its files, and the instruction to return one verdict per its own contract:
**OK**, **Conflict** (quote the rule and the conflicting code), or **Gap** (source silent).

Do not review the code yourself here. The reviewers own the authoritative sources. Your job is the
dispatch and the reconcile.

## 4. Reconcile

Collect the verdicts into one table of area → OK / Conflict / Gap, with a one-line reason. Then:

- **Any Conflict** means the change violates an authoritative rule. Surface it with the quote, then
  fix or flag it before handoff.
- **Gap** means the source is silent. Note it as a judgment call for the user.
- **All OK** means the change is consistent with every touched area's source of truth. Say so.

## Notes

- Reviewer agents ship as **DRAFTs** (`npx houserules modules --modules=reviewers`). Each needs its
  authoritative source filled in before its verdict means anything, and `npx houserules doctor` flags
  any still-DRAFT reviewer. A DRAFT reviewer's verdict is not trustworthy, so treat it as unreviewed.
- This dispatches reviewers. It does not run tests. For scoped verification, use `/verify-changed`.
- This is the general per-target dispatcher, not a design or accessibility specialist. A change
  that touches markup or styled components is better served by `/accessibility-review` or
  `/design-review`, which own those verdicts directly.
