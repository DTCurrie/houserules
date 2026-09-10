# @houserules/test

## 0.1.3

### Patch Changes

- 4a119d0: Rule-conformance fixes: tighter test helper types, corrected comments and shipped prose.

## 0.1.2

### Patch Changes

- c3268ac: Skills, rules, and rendered CLAUDE.md sections now forbid citing ledger ids in public text.
- 459999a: Doctor scans settings hooks and config for hygiene problems and secret-shaped values.

## 0.1.1

### Patch Changes

- 6a5152b: External dependency versions are now managed through the pnpm workspace catalog.

## 0.1.0

### Minor Changes

- 359e22c: Initial release. Shared testing infrastructure for driving the houserules CLI against synthetic repos.

  `useRepo` builds a bare fixture and `useInstalledRepo` stages a cached post-`init` snapshot, so a suite that is not about `init` does not run it. Snapshots are keyed by a hash of the fixture shape, so a many-plugin install stages regardless of where the repo is checked out. Also ships the CLI and script runners, and the installed-tree and doctor-report readers.

  Used by the CLI's own suites and available to plugin authors. `vitest` is a peer dependency.
