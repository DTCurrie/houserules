---
name: backlog-adopt
description: Adopt a reported GitHub issue into the backlog ledger and the linked project board. Use to triage or track a GitHub issue or bug report as a backlog entry.
argument-hint: <issue-number>
allowed-tools: Bash(gh issue view:*), Bash(node .claude/scripts/backlog-log.mjs:*), Bash(node .claude/scripts/projects-sync.mjs:*), Bash(node .claude/scripts/adopt-lint.mjs:*), Agent
---

Turn a reported issue into a tracked backlog entry, without rewriting the reporter's words.
Argument: $ARGUMENTS

## Steps

1. Read the issue once:
   `gh issue view <n> --json number,title,body,url,labels,author,state`
2. Check the body for `<!-- houserules:entry:` first. If that marker is already there, the
   issue is already adopted. Report the entry id it names and stop. Do not create a second
   entry for the same issue.
3. Resolve which target the entry belongs to. Check the issue's labels against the
   configured targets first, then any repo paths named in the body against those same
   targets, then ask the user if neither points at one target. Never guess. The target
   picks which board the entry lands on, and a wrong pick puts it in front of the wrong
   maintainers.
4. Write the entry:
   `node .claude/scripts/backlog-log.mjs add <PREFIX> <area> "<title>" "<content>" --issue <n>`
   Mirror the issue's own title. Write the content as your own triage notes, and include
   the issue URL and the reporter's handle so the entry links back. The reporter's original
   words stay in the issue. This command never edits them.
5. Push it to the board:
   `node .claude/scripts/projects-sync.mjs push`
   The entry carries an issue number, so the push attaches that existing issue to the
   board and sets its fields. It does not create a new issue.
6. Check the local ledger for the structural gaps a script can catch, offline:
   `node .claude/scripts/adopt-lint.mjs`. It flags a GitHub issue claimed by two local
   entries, an adopted entry whose title has drifted from what the last `pull` cached, and
   two configured targets whose label or path prefix collide. It cannot see the live issue
   body, so it does not replace step 2's marker check or step 3's target resolution, both of
   which stay judgment calls on live data this script never fetches.
7. Spawn the `backlog-reviewer` subagent on the new entry, the same as `/backlog-add`, to
   validate format, dedupe, and gut-check whether it is worth tracking.

## What this does not touch

The issue's title and body are never rewritten. The only write houserules makes to a
reporter's issue is appending the `<!-- houserules:entry:<ID> -->` marker during the push in
step 5, so a later adoption attempt can detect it and refuse to duplicate the entry.
