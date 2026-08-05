---
name: backlog-add
description: Log an out-of-scope discovery to the backlog ledger, then gut-check it with the backlog-reviewer agent. Use when deferring real work found mid-task instead of fixing it inline.
argument-hint: <PREFIX> <BACKLOG.md|area> "<title>" "<summary>"
allowed-tools: Bash(node .claude/scripts/backlog-log.mjs:*), Agent
---

Log a deferred work item without bloating the current diff. Arguments: $ARGUMENTS

1. Run: `node .claude/scripts/backlog-log.mjs add $ARGUMENTS`
   PREFIX is the area code, listed in the kit.config.json targets. The second argument says
   where the entry lands. Pass a bare target name such as `studio` and it resolves to
   `.claude/ledgers/studio.BACKLOG.md`. For the repo-wide backlog, pass `BACKLOG.md`. If the
   summary is long, pipe it on stdin.
2. Capture the printed `<PREFIX>-<hex>` ID.
3. Spawn the `backlog-reviewer` subagent on the new entry to validate format, dedupe, and
   gut-check whether it's worth tracking. Reconcile its verdict before continuing.

Do not start working the item. This only records it. Keep doing what you were doing.
