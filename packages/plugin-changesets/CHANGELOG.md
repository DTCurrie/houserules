# @houserules/plugin-changesets

## 0.6.1

### Patch Changes

- dc02aae: Manual mode support: hooks, skills, and agents ignore rejected edits, stop rewriting files unprompted, and warn before subagent fan-out.

## 0.6.0

### Minor Changes

- 7ac34e1: Add @houserules/plugin-wireit, and move wireit specifics out of core scripts into plugin-written extension fragments.

### Patch Changes

- 7ac34e1: Payload scripts share one `repoRoot`, and `requireRepoRoot` refuses outside a git work tree.
- 7ac34e1: The changeset gate matches `ignore` with changesets' own matcher and treats `main` and `bin` files as shipped.

## 0.5.1

### Patch Changes

- 960b086: Changeset summaries are capped at 20 words, checked on write.

## 0.5.0

### Minor Changes

- eac8920: The changeset gate no longer blocks majors and absorbs on transcript ordering.

## 0.4.1

### Patch Changes

- 60517b4: Skills, rules, and templates now say what happens when a module they mention is absent.
- 2b40197: Changeset gate no longer flags absorbs and major bumps the user approved.

## 0.4.0

### Minor Changes

- 2161dc4: The changeset-condense skill is folded into /changeset as a condense section.

### Patch Changes

- 2161dc4: Checkers fail and name the path when a file argument cannot be read.

## 0.3.3

### Patch Changes

- fb9eb89: Changeset Stop hooks no longer block on background agents' unfinished edits.

## 0.3.2

### Patch Changes

- a198513: Shorten the managed CLAUDE.md region and resident skill and agent descriptions.
- a198513: Changeset presence nudge skips the packages the changeset gate skips.
- a198513: Retune agent and slice effort defaults for the current Claude models.
- f83c4e8: Changeset gate ignores an edit under a package's unshipped top-level test directory.

## 0.3.1

### Patch Changes

- 482a44d: Changeset gate skips ignored, private, and unshipped-file packages, scopes to the turn, and honors changesets.gateIgnore.

## 0.3.0

### Minor Changes

- 3be211a: brief-driven reviewer and writer agents skip CLAUDE.md with omitClaudeMd

### Patch Changes

- f00d21d: Stop hooks skip a turn whose tool uses were all read-only.

## 0.2.4

### Patch Changes

- 5a0f02c: Prose voice requires American English and prose-lint flags British spellings.

## 0.2.3

### Patch Changes

- 4a119d0: Rule-conformance fixes: tighter test helper types, corrected comments and shipped prose.

## 0.2.2

### Patch Changes

- 01cd6e4: changeset-write refuses summaries carrying ledger-id-shaped strings.
- 01cd6e4: changeset-gate no longer flags package-root docs that ship in no tarball.

## 0.2.1

### Patch Changes

- c3268ac: Skills, rules, and rendered CLAUDE.md sections now forbid citing ledger ids in public text.

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
