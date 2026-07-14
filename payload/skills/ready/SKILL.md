---
name: ready
description: Off-context pre-handoff roll-up — run the deterministic pre-handoff checks and return ONE ready / not-ready verdict plus the falsifiable acceptance checklist the change should be judged against, including a "backlog item resolved but not removed" check. Use right before handing a finished change back to the user.
allowed-tools: Bash, Read, Grep, Glob, Agent
---

Roll the pre-handoff checks into a **single ready / not-ready verdict** plus the acceptance checklist
the user can actually verify. Keep the heavy work off this context — delegate to the scoped skills
and read only their compact results.

## 1. Verify (delegate — do not run the full suite here)

If `/verify-changed` is installed (`.claude/skills/verify-changed/`), invoke it and take its
per-package PASS/FAIL verdict as the verification result. If it is not installed, spawn **one**
subagent to run the repo's verify/test command and return only PASS/FAIL + any failing residue — do
not stream the full suite into this context.

## 2. Review (delegate if reviewers exist)

If reviewer agents are installed (`.claude/agents/*-reviewer.md`, non-DRAFT), invoke `/review-change`
and take its OK/Conflict/Gap reconciliation. If none exist, skip — say review was not run.

## 3. Changeset / handoff hooks (don't re-run — just report)

The kit's Stop hooks already enforce the auto-fix and changeset-nudge on every turn boundary. Do
**not** re-run them. Only confirm the deterministic state they check:

- **Changeset present** if the change is user-visible: `ls .changeset/*.md` (excluding README) shows a
  pending entry, or record why none is needed.
- **Working tree** matches what you intend to hand off: `git status --porcelain` (nothing stray).

## 4. Backlog resolved-but-not-removed (the novel check)

A backlog item you _fixed_ during this work must be _removed_ from its ledger — a resolved item left
in `BACKLOG.md` misleads the next session. Detect it:

```
git diff --name-only    # did this change touch files a backlog entry is about?
grep -rn "CLAUDEKIT-\|<PREFIX>-" BACKLOG.md **/BACKLOG.md 2>/dev/null
```

For each open backlog entry whose subject the current change plausibly resolves, flag it: _"<ID> looks
resolved by this change but is still in <file> — remove it with `node
.claude/scripts/backlog-log.mjs remove <ID> <file> "<resolution>"`."_ Do not auto-remove; surface the
candidates for the user's call.

## 5. Emit the verdict + acceptance checklist

Produce, in this order:

1. **VERDICT: READY** or **VERDICT: NOT READY** — not-ready if verify failed, a reviewer returned
   Conflict, a user-visible change has no changeset, or a resolved backlog item lingers.
2. **Blockers** (only if not ready): one line each, with the exact fix.
3. **Acceptance checklist** — the falsifiable "done" criteria for this change, as checkboxes the user
   can confirm in the running system (a test passes, a route returns 200, a flag flips). This is the
   CLAUDE.md-mandated hand-off artifact; emit it every time, ready or not.

Keep the whole output compact — this is a summary the user reads at a glance, not a transcript.
