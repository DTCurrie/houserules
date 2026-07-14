---
name: verify-changed
description: Verify a change off-context — run check/test/lint on only the changed packages plus their transitive dependents, and return a compact PASS/FAIL-per-package verdict instead of a multi-minute full-suite transcript. Use before handing off a change in a workspace/monorepo, in place of running the whole suite in the main context.
allowed-tools: Agent
---

Verify the current change **without pulling the full test transcript into this context.**

The point of this skill is the off-context boundary: a full monorepo verify is minutes of
streaming output. You must **not** run it here. Instead spawn **one** subagent that runs the
resolver, executes the scoped commands, and returns only the verdict.

## What to do

Spawn a single general-purpose subagent (one `Agent` call) with the instructions below. Do not
run any Bash yourself — this skill's `allowed-tools` is `Agent` precisely so the work stays off
this context.

> **Subagent brief — scoped verify:**
>
> 1. Run `node .claude/scripts/verify-changed.mjs --run` from the repo root.
> 2. That helper resolves the MINIMAL scope — the packages whose files changed vs the base branch,
>    plus every package that transitively depends on them — runs each package's verify commands, and
>    prints one line per package (`<pkg>: PASS` or `<pkg>: FAIL (<step>)`), with a trimmed residue
>    tail on stderr for any failure. Exit code is 2 if any package failed, 0 otherwise.
> 3. Return **only**: the per-package PASS/FAIL lines, and for each FAIL the failing step plus the
>    shortest residue that identifies the fix. Do **not** paste full command output.
> 4. If the helper reports `FULL SCOPE (git/config unavailable)`, say so — the scope was degraded to
>    every package.

## Reconcile

Relay the subagent's verdict: which packages passed, which failed and why (one line each). If
everything passed, say the change verifies clean and is ready for the user to commit. If anything
failed, fix it (or hand the specific residue back), then re-run this skill — never wave a red verdict
through.

## Notes

- Scope math and command selection live in `verify-changed.mjs` (config: the `verify` block +
  per-target `verifyCommands` in `.claude/kit.config.json`) — tune there, not here.
- Preview the scope without running anything: `node .claude/scripts/verify-changed.mjs` prints the
  plan; `--json` emits it machine-readably.
- This replaces a hand-maintained "shared packages" list: dependents come from the workspace
  dependency graph, so a change to a leaf package still verifies its consumers.
