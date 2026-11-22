# houserules

<!-- houserules:claude-md start -->

@.claude/houserules.md

<!-- houserules:claude-md end -->

Interactive installer for portable Claude Code context discipline. Read
`packages/cli/README.md` for the product story. This file is for working on houserules itself.

## Workspace

A pnpm workspace of seventeen packages. Per-package conventions live in each package's own
CLAUDE.md (`cli`, `api`, `payload`, `test`), loaded when you touch that package.

- `packages/cli` is `@houserules/cli`, the installer. It ships the binary **`houserules`**.
- `packages/create` is `@houserules/create`, the initializer `npm create @houserules`
  resolves. No source, no tests. The bare name `houserules` is unpublishable, npm holds it too close
  to `house-rules`.
- `packages/api` is `@houserules/api`, the plugin contract package: action types, module
  definitions, and the `houserules.config.json` schema plugin authors build against.
- `packages/payload` is `@houserules/payload`, the shared payload libs.
- Twelve first-party plugins, each `packages/plugin-<name>`. Six hold modules that moved
  out of the core.
- `packages/test` is `@houserules/test`, the shared testing modules, imported via `#test/*`.
- The workspace root owns repo-wide concerns only: `prettier`, `eslint`, changesets, the
  workflows, `CLAUDE.md`, and the gitignored `.claude/`.

Read before the occasion, not after:

- Test work (writing, moving, or staging tests): `docs/testing.md`.
- Payload work (any script, lib, or prose that ships to user repos): `docs/payload.md`.
- Wiring a package's `build`/`check`/`test` scripts, tsconfigs, or wireit blocks:
  `docs/package-checks.md`.

## Edits

- **Edit, do not rewrite.** A change to part of a file is an `Edit` of that part. Reach for
  `Write` only for a new file or when more than half of an existing one changes. A whole-file
  rewrite to make a small change discards the user's unsaved edits and buries the real diff
  in a reformat.

## Commands

Every `build`, `check`, and `test` script runs through wireit. Its skip and `files` glob
rules are in `docs/package-checks.md`.

- `pnpm build`: `tsc` → `dist/`, assemble `payload-dist/`, regenerate the JSON Schema.
  Required before any `dist/` probe.
- `pnpm check`: `tsc --noEmit` over `src/` + `test/` + colocated `__tests__/` dirs, then the
  root `verify` block of post-build assertions, so a cold run builds first.
- `pnpm test`: full suite, including end-to-end init/update/doctor on fixtures. A bare
  `npx vitest` needs a prior `pnpm build`.
- `pnpm lint` / `pnpm lint:fix`: run from the workspace root only. No package defines its
  own `lint` script.
- `pnpm change`: record a changeset. Required for any user-visible change, and dogfooded.
- `pnpm dogfood` / `pnpm dogfood:watch`: run the real installer over this repo, once or
  live. Caveats: `packages/cli/CLAUDE.md`.
- `node packages/cli/dist/cli.js init --yes --dry-run <repo>`: safe manual probe against
  any repo.

Gates, in order: `pnpm format`, `pnpm lint:fix`, `pnpm check`, `pnpm test`. Scope with
`pnpm --filter <pkg>`. Prefer the full run when you are unsure what you touched.

## Release

changesets: merge to main → release workflow opens/updates a "Version Packages" PR →
merging that publishes to npm. Never hand-edit CHANGELOG.md.
