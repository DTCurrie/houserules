# claude-kit

npm-published interactive installer (`npx claude-kit init`) for a portable Claude Code
context-discipline kit. Read README.md for the product story; this file is for working on
the kit itself.

## Layout

- `cli/`: the installer — detect → plan (declarative actions) → preview → apply. May use
  npm dependencies (@clack/prompts, picocolors).
- `payload/`: everything copied into user repos (`scripts/`, `skills/`, `agents/`,
  `output-styles/`, `kit-templates/`). **Zero runtime dependencies, node builtins only,
  POSIX shells.** Hook scripts must never crash: config via `loadConfigSafe()`, exit 0 on
  any failure path.
- `test/`: node:test suites + `fixtures.mjs` generators (pnpm-monorepo / npm-single /
  non-js), all in mkdtemp dirs.

## Commands

- `pnpm test` — full suite (includes end-to-end init/update/doctor on fixtures).
- `node cli/index.mjs init --yes --dry-run <repo>` — safe manual probe against any repo.
- `pnpm change` — record a changeset (required for any user-visible change; dogfood).

## Rules

- The plan/apply boundary is load-bearing: modules return actions, only `cli/apply.mjs`
  writes, dry-run renders the same computed effects. Never add filesystem writes elsewhere.
- Kit-owned vs user-owned: copies/writes are manifest-tracked and update-refreshable; seeds
  (kit.config.json, CLAUDE.md, reviewer drafts, .changeset/config.json) belong to the user —
  never overwrite.
- init never runs package-manager installs and never edits an existing CLAUDE.md or
  settings.local.json.
- The user always handles `git commit` / `push` / PR-create.

## Release

changesets: merge to main → release workflow opens/updates a "Version Packages" PR →
merging that publishes to npm (`NPM_TOKEN` secret required). Never hand-edit CHANGELOG.md.
