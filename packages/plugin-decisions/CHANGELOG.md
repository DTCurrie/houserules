# @houserules/plugin-decisions

## 0.1.4

### Patch Changes

- 6a5152b: External dependency versions are now managed through the pnpm workspace catalog.

## 0.1.3

### Patch Changes

- 7b5f72a: Adopt the Jest-standard **tests** directory name for test colocation.

## 0.1.2

### Patch Changes

- cb34f11: Drop duplicate payload peerDependencies, dedupe naming clause into code-cleanliness, take clack 1.x
- cb34f11: decision-lint skips superseded records, whose supersessor owes the required fields
- cb34f11: Share ledger guard helpers from entry-ledger, ending drifting local copies across scripts

## 0.1.1

### Patch Changes

- 269dd06: Ledger write guards compare against the pulled index when a projects sync is configured
- 269dd06: Normalize agent frontmatter, scope testing-3d rule to tests, point svelte rule at svelte-lint, add missing script shebangs

## 0.1.0

### Minor Changes

- 359e22c: Initial release. An append-only decision ledger, the /decide skill, and the decision-reviewer agent.

  A record holds what was decided, the alternative that was rejected, and the condition that would reopen it. The bar is that the decision is not obvious from the code, a competent person could have chosen otherwise, and re-deriving it costs real time.

  Recording asks whether the revisit trigger is path-watchable. When it is, that path goes in `--scope`, and prompt injection surfaces the decision when someone touches it. When it is not, it stays prose and nobody is notified, which is honest rather than falsely covered. `supersede` links a replacement to what it replaces instead of flattening both into one record.
