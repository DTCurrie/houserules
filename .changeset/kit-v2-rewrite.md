---
"claude-kit": major
---

v2: complete rewrite around a single-command interactive installer and changesets-canonical
changelogs.

- `npx claude-kit init` — detects the repo (package manager, workspace packages, divergent
  fix scripts, TypeScript, existing changesets and .claude state), offers a module
  multiselect, previews every file and the exact settings.json diff, then applies
  non-destructively. `--dry-run`, `--yes`, `--modules` for headless use. `update` refreshes
  kit files without clobbering local edits (manifest receipt + hashes); `doctor` validates
  the install against repo reality.
- Changesets integration: zero-dep `changeset-write.mjs` (workspace-validated), `/changeset`
  skill, `changeset-writer` haiku agent, branch-aware `changeset-check` Stop hook. The
  per-commit ledger is now an opt-in module writing to `.claude/changelogs/` so it can never
  collide with `changeset version`.
- New modules: session-start context header, terse output style (caveman-derived, MIT),
  experimental tool-output compactor (spill + head/tail pointer), per-target reviewer DRAFTs.
- guard-bash rules are now configured via kit.config.json (schema v2) with hardcoded-default
  fallback; lint-format-fix supports per-target fixCommands overrides.
- Replaces the copy-everything `install.mjs` and hand-merged settings.kit.json.
