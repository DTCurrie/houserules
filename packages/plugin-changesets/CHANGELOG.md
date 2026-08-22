# @houserules/plugin-changesets

## 0.2.0

### Minor Changes

- b986353: changeset-write keeps a local record of each changeset it writes

## 0.1.4

### Patch Changes

- f1b13b5: changeset-gate no longer counts wireit-block and tsconfig-only edits as shippable (PLUGINCHANGE-553a5d).
- 6a5152b: External dependency versions are now managed through the pnpm workspace catalog.

## 0.1.3

### Patch Changes

- 7b5f72a: Adopt the Jest-standard **tests** directory name for test colocation.

## 0.1.2

### Patch Changes

- cb34f11: Drop duplicate payload peerDependencies, dedupe naming clause into code-cleanliness, take clack 1.x
- cb34f11: Share ledger guard helpers from entry-ledger, ending drifting local copies across scripts

## 0.1.1

### Patch Changes

- 269dd06: Memoize repo-root resolution and drop duplicate git spawns from hot hooks

## 0.1.0

### Minor Changes

- 359e22c: Initial release. Changesets integration and the optional per-commit changelog ledger.

  `/changeset` records a pending release note for the packages a change touched, one entry per feature, and the `changeset-writer` agent picks the bump level from the diff. `/changeset-condense` folds entries that describe one feature, which matters when a later change made an earlier note false. A Stop hook nudges when package source changed with nothing recorded.

  The optional `ledger` module adds a per-commit changelog built on the same records.
