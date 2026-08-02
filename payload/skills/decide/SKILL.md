---
name: decide
description: Record a decision to the nearest DECISIONS.md ledger, with the rejected alternative and revisit trigger that make it worth keeping. Use when a discussion settles a design question, when recording why we chose one option over another, or when a new decision supersedes a prior one.
argument-hint: decide|supersede|amend <args...>
allowed-tools: Bash(node .claude/scripts/decision-log.mjs:*), Agent
---

Log a decision from context so re-deriving it later is a grep, not a reconstruction.

## The bar

Record a decision only when all three hold:

1. It constrains code in a way that is not obvious from reading the code.
2. A competent person would plausibly have chosen otherwise.
3. Re-deriving it costs real time, or getting it wrong causes real damage.

"We use TypeScript" fails rule 2. "The bridge replaced portals, because a neutral no-build
band keeps the walkable space one connected region for the navmesh" passes all three. This
bar is what separates a decision log from a diary. If it does not clearly pass, do not record it.

## What a record holds

- **Why.** Stops the same argument from happening twice.
- **Rejected.** The alternative considered and passed over. This is the highest-value field
  and the one no other artifact holds.
- **In the code.** The paths that exist because of this decision, so the record is auditable
  against the tree.
- **Revisit when.** A falsifiable trigger. A decision with no stated exit becomes dogma.

## Refuse without a rejected alternative or a revisit trigger

Those two fields are the ones everyone skips, and the ones that carry the value. If you
cannot state a genuine rejected alternative or a genuine revisit trigger, do not invent a
plausible-sounding one to pass the check. That is worse than refusing. Ask the user for the
missing piece, or conclude this is not actually a decision and drop it.

## Commands, from `.claude/scripts/decision-log.mjs`

- `decide <prefix> <file> <title> [body] [--under <id>] [--supersedes <id>,<id>] [--scope <path>,<path>] [--chat <id>]`
- `supersede <id> <file> <new-title> [body] [--scope <path>,<path>] [--chat <id>]`. Writes a
  new record. It never edits the old one. Nothing is ever deleted.
- `amend <id> <file> <new-body>`. Corrects a record's wording without changing its outcome.
  The log keeps both versions, so use `supersede` when the decision itself changed.

When `[body]` is omitted, pipe it on stdin.

## CLAUDE.md boundary

CLAUDE.md holds only the few decisions that must be in context on every turn. The decision
log holds the long tail, plus the full supersession history. A decision promoted into
CLAUDE.md still gets a record here, and the CLAUDE.md line cites its id.

## Where the file goes

`DECISIONS.md` beside the area it governs. The tool discovers it from `<file>`. Repo-wide
decisions go in a root `DECISIONS.md`.

## Steps

1. Check the bar above. If it does not pass, say so and stop.
2. Draft Why, Rejected, In the code, Revisit when. If Rejected or Revisit when is missing,
   ask the user rather than inventing one.
3. Run `node .claude/scripts/decision-log.mjs decide <prefix> <file> "<title>" "<body>"`
   (or `supersede`/`amend` as appropriate).
4. Spawn the `decision-reviewer` subagent on the new entry to check it against the bar.
