---
'@houserules/plugin-backlog': minor
---

Initial release. An append-only backlog ledger, with the add skill and reviewer agent around it.

`/backlog-add` logs an out-of-scope discovery instead of fixing it inline, and the `backlog-reviewer` agent gut-checks the entry for format, duplication, and whether it is worth tracking at all. Entries carry an area, so a monorepo renders one surface per package.

The ledger is the record. The rendered markdown is a generated surface and can lie, so read scope from the `.jsonl`.
