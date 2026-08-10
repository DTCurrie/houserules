---
'@agent-kit/plugin-github': minor
---

Initial release. Syncs the backlog and decision ledgers to GitHub Projects.

Backlog entries become issues and decisions become draft items, on one board per ledger per repo, with each item's target carried in an `Area` field. The local `.jsonl` is a QUEUE rather than a record: it holds only what has not reached the board, so a synced repo's queue is empty, and `pull` rebuilds a local index and re-renders every surface from the boards.

Pushing needs both a local `.claude/ledgers/.projects.json` that only `bootstrap` writes and maintain or admin on the repository, so no committed file can grant board access. `pull` needs only read access, so a contributor who cannot push can still hold an index. `/ledger-sync` and `/backlog-adopt` cover the manual paths, and `projects.autoSync: false` forbids syncing repo-wide.
