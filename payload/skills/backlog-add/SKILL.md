---
name: backlog-add
description: Log an out-of-scope discovery to the nearest BACKLOG.md ledger, then gut-check it with the backlog-reviewer agent. Use when deferring real work found mid-task instead of fixing it inline.
argument-hint: <PREFIX> <path/to/BACKLOG.md> "<title>" "<summary>"
allowed-tools: Bash(node .claude/scripts/backlog-log.mjs:*), Agent
---

Log a deferred work item without bloating the current diff. Arguments: $ARGUMENTS

1. Run: `node .claude/scripts/backlog-log.mjs add $ARGUMENTS`
   (PREFIX = the area code for that BACKLOG.md's path — see kit.config.json targets;
   if the summary is long, pipe it on stdin.)
2. Capture the printed `<PREFIX>-<hex>` ID.
3. Spawn the `backlog-reviewer` subagent on the new entry to validate format, dedupe, and
   gut-check whether it's worth tracking. Reconcile its verdict before continuing.

Do not start working the item — this only records it. Keep doing what you were doing.
