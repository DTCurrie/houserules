---
paths:
  - '**/package.json'
---

# Wireit

[wireit](https://github.com/google/wireit) owns the dependency graph and the incremental skipping for a package's scripts. A script whose declared inputs are unchanged is skipped, so every mistake in a `wireit` block fails silently, by skipping work that should have run. This rule covers what a block must declare, how to run it, and what a cache hit proves.

## Rule

### Declare every input and output

- **Declare every read class of a script in `files`.** Sources, configs, tsconfigs, `package.json`, and fixtures. A read outside `files` is a stale cache hit, because wireit never sees the change. Add the glob the same day you add the input.
- **Exclude `!**/node_modules/**` from any directory glob rooted at or above the package root.** A `node_modules` symlink loop runs wireit out of heap.
- **Declare `output` on every script.** Use `[]` for a check. The `clean: true` default and cache restore both need it, and a deleted source then leaves no orphan in the output.
- **Name a cross-package dependency as `../<pkg>:<script>`.** Naming a script that does not exist is a wireit error.

### Read a cache hit for what it proves

- **A hit on unchanged declared inputs is a pass.** That is the reason the cache exists, so do not clear wireit state to force a rerun.
- **A hit proves nothing about a file outside `files`.** When a changed file sits outside the declared inputs, verify it directly.
- **A progress line such as ` 88% [` is not a verdict.** Read the exit code.

### Run it

- **Forward arguments with `--`.** `pnpm --filter <pkg> test -- <file>`. Without it wireit drops them.
- **Cap `WIREIT_PARALLEL` inside a parallel run.** It limits wireit's own fan-out. A run inside a wave sets it to 1 beside the test runner's worker variable. Where `.claude/extensions/wireit.json` is installed, `verify-changed` sets it per job.
- **Build a shared package once, before parallel workers start.** `clean` empties the `output` directories first, so a sibling that imports from them fails mid-step. No worker runs that package's `build`.
- **Delete `.wireit` state only after a change to a block's `files` or `dependencies`.** Deleting it any other time throws away a valid cache.
- **Rerun once without watch after a delete.** Watch mode (`WIREIT_WATCH=true`) does not handle a deleted input.

### Where other rules apply

- How the sentence inside a comment reads: see `prose-voice.md` if that rule is installed.
- Naming and dead code in scripts that wireit runs: see `code-cleanliness.md` if that rule is installed.
- Formatting: the repo's own formatter owns it, not this rule.

## Checked mechanically

`.claude/scripts/wireit-lint.mjs` checks:

- A `"wireit"` script with no block.
- A block with no script.
- A directory glob with no `node_modules` exclusion.
- A block with a `command` and no `files`.
- A block with no `output`.
- A dependency naming a missing script.

Everything else in this rule is a human read, including whether `files` covers every input a script actually reads.
