# @houserules/plugin-github

## 0.2.3

### Patch Changes

- 4a119d0: Rule-conformance fixes: tighter test helper types, corrected comments and shipped prose.

## 0.2.2

### Patch Changes

- 459999a: Skill descriptions no longer narrate the skill's internal steps.

## 0.2.1

### Patch Changes

- 6a5152b: External dependency versions are now managed through the pnpm workspace catalog.

## 0.2.0

### Minor Changes

- cb34f11: Sync Scope/Under fields, keep markers on update pushes, add reconcile for surface orphans

### Patch Changes

- cb34f11: Drop duplicate payload peerDependencies, dedupe naming clause into code-cleanliness, take clack 1.x
- cb34f11: Share ledger guard helpers from entry-ledger, ending drifting local copies across scripts

## 0.1.1

### Patch Changes

- 269dd06: Memoize repo-root resolution and drop duplicate git spawns from hot hooks

## 0.1.0

### Minor Changes

- 359e22c: Initial release. Syncs the backlog and decision ledgers to GitHub Projects.

  Backlog entries become issues and decisions become draft items, on one board per ledger per repo, with each item's target carried in an `Area` field. The local `.jsonl` is a QUEUE rather than a record: it holds only what has not reached the board, so a synced repo's queue is empty, and `pull` rebuilds a local index and re-renders every surface from the boards.

  Pushing needs both a local `.claude/ledgers/.projects.json` that only `bootstrap` writes and maintain or admin on the repository, so no committed file can grant board access. `pull` needs only read access, so a contributor who cannot push can still hold an index. `/ledger-sync` and `/backlog-adopt` cover the manual paths, and `projects.autoSync: false` forbids syncing repo-wide.
