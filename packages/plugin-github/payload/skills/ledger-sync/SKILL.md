---
name: ledger-sync
description: Push the local backlog and decisions ledgers to GitHub Projects, syncing backlog entries to issues and decisions to draft items on the project board. Use when the user asks to sync, push, or upload the ledger, backlog, or decisions to GitHub Projects or the project board, or asks why an entry has not shown up there.
argument-hint: status|push [--dry-run]
allowed-tools: Bash(node .claude/scripts/projects-sync.mjs:*)
---

Push the backlog and decision ledgers to the linked GitHub Project boards.

## Steps

1. Check what would happen first:
   `node .claude/scripts/projects-sync.mjs status`
   This prints whether the sync gate currently allows pushing, how many entries are pending
   per ledger, and which project each ledger and target resolves to.
2. If the queue is large or you have not run this before, preview it without changing
   anything:
   `node .claude/scripts/projects-sync.mjs push --dry-run`
3. Push for real:
   `node .claude/scripts/projects-sync.mjs push`

## If a push fails partway

Failures are per entry, and the run keeps going through the rest of the queue. A failed
entry writes no `synced` record, so re-running `push` retries exactly the entries that
failed and leaves the ones that already synced alone.

## If the run stops on a 403 or 404

That is access being refused, not one bad entry. The whole run ends immediately, because
every remaining entry would fail the same way. Do not retry. Pushing needs two things, and
both have to hold: a local `.claude/ledgers/.projects.json`, which only `bootstrap` writes,
and `maintain` or `admin` on the repository. Fix whichever is missing.

## If `status` says sync is blocked

That is the designed behavior, not an error to debug. A contributor without `maintain` or
`admin` on the repository gets a working local ledger and nothing pushes anywhere. Do not
try to work around it. The path in is the issues tab: file the entry there and a maintainer
adopts it onto the board.

## If `status` reports no local project mapping

A maintainer needs to run `node .claude/scripts/projects-sync.mjs bootstrap` once, before
any `push` can run. `bootstrap` also needs `maintain` or `admin` access. If you do not have
it, ask a maintainer to run it.
