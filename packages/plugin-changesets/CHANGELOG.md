# @houserules/plugin-changesets

## 0.1.1

### Patch Changes

- 269dd06: Memoize repo-root resolution and drop duplicate git spawns from hot hooks

## 0.1.0

### Minor Changes

- 359e22c: Initial release. Changesets integration and the optional per-commit changelog ledger.

  `/changeset` records a pending release note for the packages a change touched, one entry per feature, and the `changeset-writer` agent picks the bump level from the diff. `/changeset-condense` folds entries that describe one feature, which matters when a later change made an earlier note false. A Stop hook nudges when package source changed with nothing recorded.

  The optional `ledger` module adds a per-commit changelog built on the same records.
