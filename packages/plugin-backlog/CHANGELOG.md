# @houserules/plugin-backlog

## 0.1.4

### Patch Changes

- 459999a: Skill descriptions no longer narrate the skill's internal steps.
- c3268ac: Skills, rules, and rendered CLAUDE.md sections now forbid citing ledger ids in public text.

## 0.1.3

### Patch Changes

- 6a5152b: External dependency versions are now managed through the pnpm workspace catalog.

## 0.1.2

### Patch Changes

- cb34f11: Drop duplicate payload peerDependencies, dedupe naming clause into code-cleanliness, take clack 1.x
- cb34f11: Share ledger guard helpers from entry-ledger, ending drifting local copies across scripts

## 0.1.1

### Patch Changes

- 269dd06: Ledger write guards compare against the pulled index when a projects sync is configured
- 269dd06: Normalize agent frontmatter, scope testing-3d rule to tests, point svelte rule at svelte-lint, add missing script shebangs

## 0.1.0

### Minor Changes

- 359e22c: Initial release. An append-only backlog ledger, with the add skill and reviewer agent around it.

  `/backlog-add` logs an out-of-scope discovery instead of fixing it inline, and the `backlog-reviewer` agent gut-checks the entry for format, duplication, and whether it is worth tracking at all. Entries carry an area, so a monorepo renders one surface per package.

  The ledger is the record. The rendered markdown is a generated surface and can lie, so read scope from the `.jsonl`.
