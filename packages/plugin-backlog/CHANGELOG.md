# @houserules/plugin-backlog

## 0.1.1

### Patch Changes

- 269dd06: Ledger write guards compare against the pulled index when a projects sync is configured
- 269dd06: Normalize agent frontmatter, scope testing-3d rule to tests, point svelte rule at svelte-lint, add missing script shebangs

## 0.1.0

### Minor Changes

- 359e22c: Initial release. An append-only backlog ledger, with the add skill and reviewer agent around it.

  `/backlog-add` logs an out-of-scope discovery instead of fixing it inline, and the `backlog-reviewer` agent gut-checks the entry for format, duplication, and whether it is worth tracking at all. Entries carry an area, so a monorepo renders one surface per package.

  The ledger is the record. The rendered markdown is a generated surface and can lie, so read scope from the `.jsonl`.
