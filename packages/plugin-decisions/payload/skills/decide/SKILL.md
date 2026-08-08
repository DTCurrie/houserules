---
name: decide
description: Record a decision to the decision ledger, with the rejected alternative and revisit trigger that make it worth keeping. Use when a discussion settles a design question, when recording why we chose one option over another, or when a new decision supersedes a prior one.
argument-hint: decide|supersede|amend|rescope <args...>
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
- **In the code.** The paths this decision governs, so the record is auditable against the
  tree. A decision to build something is scoped to the code it produced. A decision NOT to
  build something has no such code, so scope it by the section below.
- **Revisit when.** A falsifiable trigger. A decision with no stated exit becomes dogma.

## Refuse without a rejected alternative or a revisit trigger

Those two fields are the ones everyone skips, and the ones that carry the value. If you
cannot state a genuine rejected alternative or a genuine revisit trigger, do not invent a
plausible-sounding one to pass the check. That is worse than refusing. Ask the user for the
missing piece, or conclude this is not actually a decision and drop it.

## Scope a prohibition to where the violation would be written

A record is only reachable from the paths its scope covers, and `scope <path>` is what an
agent runs before working in an area. A decision to build something scopes itself, because
the code it produced is right there. A decision not to build something has no such code, and
scoping it to the file it protects hides it from whoever builds the thing.

Take a decision to keep a baked asset and its generator uncompared, scoped to
`src/sim/debugLevel.ts`. The code that would violate it is a test, and that test gets written
at `src/sim/__test__/levelBake.test.ts`. `scope` on that path returns nothing, which reads as
"no decision governs this file" and is indistinguishable from the truth. Scoping the record to
`src/sim` reaches both.

So ask where the violating code would land, and cover that path too. Usually it means naming
the containing directory rather than the one file, since a path matches any directory scope
above it.

## Check for an existing decision first

Before recording, ask whether one already governs this ground:

```
node .claude/scripts/decision-log.mjs scope <path>   # paths the work touches
```

A path matches a decision scoped to any directory above it, so a file finds the decision that
governs its package. If one comes back covering the same question, this is a `supersede` of it,
not a second record. Two decisions on one question is how a log stops being answerable.

Nothing else can answer this. The recorded scope only exists in the ledger, and grepping the
rendered `DECISIONS.md` cannot match a file against a directory scope.

## Repair a stale scope after a move

A scope holds literal paths, and a rename updates none of them. `scope` warns on stderr when an
accepted record names a path that is gone from disk. Clear it by pointing the record at where
the code went:

```
node .claude/scripts/decision-log.mjs rescope <id> --scope <new-path>,<new-path>
```

Do this whenever you move a file a decision governs, in the same change as the move. Leaving it
is not a cosmetic debt: `scope <new-path>` returns nothing, which reads as "no decision governs
this file" and is indistinguishable from the truth.

`rescope` is not `supersede`. A move re-decides nothing, so the record keeps its id, its
content, and its status. Supersede only when the decision itself changed.

## Commands, from `.claude/scripts/decision-log.mjs`

- `scope <path> [<path>...]`. Which decisions govern these paths. Run this before recording.
- `list [<file>]`, `show <id>`. Survey every decision, then read one in full.
- `ancestry <id>`, `current <id>`, `tree <id>`. Walk the supersession chain.
- `decide <prefix> <file> <title> [body] [--under <id>] [--supersedes <id>,<id>] [--scope <path>,<path>] [--chat <id>]`
- `supersede <id> <file> <new-title> [body] [--scope <path>,<path>] [--chat <id>]`. Writes a
  new record. It never edits the old one. Nothing is ever deleted.
- `amend <id> <file> <new-body>`. Corrects a record's wording without changing its outcome.
  The log keeps both versions, so use `supersede` when the decision itself changed.
- `rescope <id> --scope <path>,<path>`. Re-points a record at where its files moved to. It
  changes paths only, so a move is not recorded as a re-decision.

When `[body]` is omitted, pipe it on stdin.

## CLAUDE.md boundary

CLAUDE.md holds only the few decisions that must be in context on every turn. The decision
log holds the long tail, plus the full supersession history. A decision promoted into
CLAUDE.md still gets a record here, and the CLAUDE.md line cites its id.

## Where the file goes

Every rendered `DECISIONS.md` lives in `.claude/ledgers/`, beside the ledger it is generated
from.

`<area>` is a bare target name from `kit.config.json`. Pass `studio` and the decision renders
to `.claude/ledgers/studio.DECISIONS.md`. For a repo-wide decision, pass `DECISIONS.md`.

## Steps

1. Check the bar above. If it does not pass, say so and stop.
2. Draft Why, Rejected, In the code, Revisit when. If Rejected or Revisit when is missing,
   ask the user rather than inventing one.
3. Run `node .claude/scripts/decision-log.mjs decide <prefix> <area> "<title>" "<body>"`
   (or `supersede`/`amend` as appropriate).
4. Spawn the `decision-reviewer` subagent on the new entry to check it against the bar.
