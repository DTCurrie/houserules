# Contributing to houserules

Thanks for looking at houserules. This file covers what a first-time contributor needs to
get from a fresh clone to a reviewable pull request.

## Prerequisites

- Node `>=22`
- pnpm, pinned via `packageManager` in the root `package.json` (currently `pnpm@11.20.0`).
  Use [corepack](https://nodejs.org/api/corepack.html) to get the exact version, or install
  pnpm directly.

## Getting set up

```sh
git clone https://github.com/DTCurrie/houserules.git
cd houserules
pnpm install
pnpm build
```

## Repo layout

This is a pnpm workspace that publishes sixteen packages: `@houserules/cli` (the installer,
which ships the `houserules` binary), `@houserules/api` (the plugin API: action types, module
definitions, and the `houserules.config.json` schema), `@houserules/payload` (the shared payload libs,
imported by package name), twelve `@houserules/plugin-*` packages, and `@houserules/test`, a
shared test library. Each package owns its own `src/`, tests, and, for the CLI and plugins, a
`payload/` directory of files the installer copies into a user's repo.
Root-level config (`prettier`, `eslint`, changesets, CI workflows) applies to the whole
workspace, since no package defines its own lint script.

## Running the checks

Run these in order. Each rewrites or reports on the whole tree, so running them in sequence
keeps later checks from flagging noise the earlier ones would have fixed.

```sh
pnpm format      # prettier --write, settles formatting first
pnpm lint:fix    # eslint --fix, catches what formatting doesn't
pnpm check       # tsc --noEmit across every package
pnpm test        # the full test suite, including end-to-end fixtures
```

Scope any of these to the package you touched with `--filter`, for example:

```sh
pnpm --filter @houserules/cli test
pnpm --filter @houserules/plugin-testing check
```

`pnpm build` runs a full build across the workspace and is required before probing anything
under a package's `dist/`.

CI's `packages` job also runs `pnpm attw` and three `pnpm verify:*` scripts
(`verify:packages`, `verify:payload-copy-set`, `verify:payload-test-coverage`) that check a
package's published shape. Run them if you touch a package's `exports`, `files`, or payload
copy list.

Every `build`, `check`, and `test` script runs through
[wireit](https://github.com/google/wireit), which means two things day to day. A script whose
inputs have not changed is skipped, so re-running a command you just ran is close to free. And
a `--filter`ed command pulls in whatever it depends on, so
`pnpm --filter @houserules/plugin-design test` builds the CLI first if it needs to, with no
separate step. Running `npx vitest` directly, outside the `test` script, does still need a
prior `pnpm build`.

## Dogfooding

```sh
pnpm dogfood
```

This wires this repo's own gitignored `.claude/` directory from every package's `payload/`,
so houserules runs its own hooks, skills, and agents against itself. It is how changes to
houserules get exercised the way a real install would use them.

If you are iterating on a hook script (a `.mts` file under a package's `payload/scripts/`),
run `pnpm dogfood:watch`. `.claude/scripts` is a copy of `payload-dist/`, not a symlink, so an
edit has to be compiled and then re-copied before it is live. The watch does both. **Deleting
a script is the one case the watch does not cover, so re-run `pnpm dogfood` after removing
one.**

## Changesets

```sh
pnpm change
```

Run this for any user-visible change. It records a changeset describing what changed and
which packages it affects, and that record is what drives the release PR and changelog.
A PR that changes behavior without a changeset will need one added before merge.

## Releases

Releases are automated from the changesets you record, in two steps. Merging to `main` makes
the release workflow open or update a "Version Packages" pull request, which applies the
pending changesets, bumps versions, and writes the changelogs. Merging that PR publishes to
npm.

Publishing needs an `NPM_TOKEN` repository secret. Never hand-edit a `CHANGELOG.md`, because
changesets owns those files and your edit is overwritten on the next version bump.

## Opening a pull request

1. Branch from `main`.
2. Make your change, keeping it inside the package(s) it belongs to.
3. Run the checks above, scoped to what you touched.
4. Run `pnpm change` if the change is user-visible.
5. Push and open a PR against `main`. Describe what changed and why, and link any related
   issue.

Please also read [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) before participating, and see
[SECURITY.md](./SECURITY.md) if you're reporting a vulnerability rather than proposing a
change.
