# houserules

<!-- houserules:claude-md start -->

### houserules sections

Maintained by `npx houserules update`. Text outside the markers is yours and never touched.
Fuller templates live in `.claude/templates/`.

### Skill triggers

- After a meaningful change to a package: record a changeset with `/changeset`, **before
  the commit**.
- Discovered a real issue outside the current scope? **Do not fix it inline.** Log it with
  `/backlog-add`.
- Settled a design question the code does not explain on its own? Record it with `/decide`.
- Too big to hold in one plan: scaffold with `/plan-project`, then execute each phase with
  `/orchestrate`.
- Ledger ids stay in the ledger, never in code, docs, changesets, commit messages, or issues.

### Conventions

- **The user always handles `git commit` / `push` / PR-create.** Describe what is ready and stop.
- **Edit from the file's current bytes.** Re-read before editing when your view of it is
  second-hand (a snapshot, a lint error, another tool's output) or the user may have it open.
- **Do not rewrite what is not yours to change.** When the user presents a file as their own
  finished work, or has it open mid-edit, surface the problem and let them decide.
- **Watch for the missing `[houserules]` SessionStart banner.** Without it, the session started
  below the repo root and the installed hooks, including the Bash guard, are not active. Tell
  the user to relaunch Claude Code from the repo root.

### Cost & verification discipline

- Implement stage-sized work (a handful of files) in-context, with no implementation subagents.
  Reserve subagents for parallel or unbounded work (wide sweeps, migrations).
- Exception, a planned phase under `/orchestrate`: dispatch as that skill says. Never pull a
  worker’s diff into the main context.
- Verify with static gates (tests, typecheck, lint) plus a short falsifiable acceptance checklist
  for the user. No browser/screenshot verification unless explicitly asked.
- Run them in order, scoped to the packages you changed: format first, then lint with autofix,
  then typecheck and test, so only real problems are left.
- **"Done" means every check passed, not that the edits were made.** Report a check that failed
  or never ran, with its output. The recorded evasions, and what each one means:
  - "The edits are in, so it is done": done is the checks passing, with output you read.
  - "I know this fact from memory": state it only after running the command that could falsify it.
  - "It passed earlier": a stale or cached pass is not this change's pass. Re-run on current bytes.
  - "The subagent reported success": the tree is the evidence, not the report.
- When the user is blocked on each turn, a cheap reversible action is itself the check. Run it
  and let its result falsify, with at most one cheaper check first.
- Derive empirical constants by parsing the artifact itself, not screenshot-and-iterate loops.
- A subagent runs a command expected to outlast the default Bash timeout with
  `run_in_background: true`, ends its turn without reporting, and reports when the completion
  notification re-invokes it, reading the output file it names. A foreground call blocks the
  subagent until Claude Code moves it to the background anyway, so starting it there saves the
  blocked minutes and lets the subagent end its turn.
- On AskUserQuestion timeout, stop and re-ask later. Never carry tentative selections forward.
- Read the repo's own docs + targeted greps before fanning out Explore/Plan agents.

### Tool-use efficiency

- `grep -n` to locate, then `Read` with `offset`/`limit`. Grep output is location data, not
  content: never judge text against a grep listing of it.
- Pipe long command output through `grep`, and batch related greps into one call.

<!-- houserules:claude-md end -->

Interactive installer for portable Claude Code context discipline. Read
`packages/cli/README.md` for the product story. This file is for working on houserules itself.

## Workspace

A pnpm workspace of seventeen packages. Per-package conventions live in each package's own
CLAUDE.md (`cli`, `api`, `payload`, `test`), loaded when you touch that package.

- `packages/cli` is `@houserules/cli`, the installer. It ships the binary **`houserules`**.
- `packages/create` is `@houserules/create`, the initializer `npm create @houserules`
  resolves. One bin that installs the cli into the repo and runs `init`, one dependency on the
  cli. No source, no tests. The bare name `houserules` is unpublishable, npm holds it too close
  to `house-rules`.
- `packages/api` is `@houserules/api`, the plugin contract package: action types, module
  definitions, and the `houserules.config.json` schema plugin authors build against.
- `packages/payload` is `@houserules/payload`, the ten shared payload libs, imported by
  package name.
- Twelve first-party plugins, each `packages/plugin-<name>`. Six hold modules that moved
  out of the core (`src/retired-modules.ts` in the cli maps ids to packages).
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

Every `build`, `check`, and `test` script runs through wireit, which owns the dependency
graph. A script whose inputs are unchanged is **skipped**, so full runs are cheap, and a
`files` glob that misses a real input fails **silently**, so add the glob the same day you
add the input (`docs/package-checks.md`).

- `pnpm build`: `tsc` → `dist/`, assemble `payload-dist/`, regenerate the JSON Schema.
  Required before any `dist/` probe.
- `pnpm check`: `tsc --noEmit` over `src/` + `test/` + colocated `__tests__/` dirs.
- `pnpm test`: full suite, including end-to-end init/update/doctor on fixtures. A bare
  `npx vitest` needs a prior `pnpm build`.
- `pnpm lint` / `pnpm lint:fix`: run from the workspace root only. No package defines its
  own `lint` script.
- `pnpm change`: record a changeset. Required for any user-visible change, and dogfooded.
- `pnpm dogfood`: run the real installer over this repo. Details and the
  scripts-are-copies caveat: `packages/cli/CLAUDE.md`.
- `pnpm dogfood:watch`: recompiles payload edits live. Deleting a script is not covered,
  so re-run `pnpm dogfood`.
- `node packages/cli/dist/cli.js init --yes --dry-run <repo>`: safe manual probe against
  any repo.

Gates, in order: `pnpm format`, `pnpm lint:fix`, `pnpm check`, `pnpm test`. Scope with
`pnpm --filter <pkg>`, which under wireit also pulls in that package's upstream builds, so
the scoped run is complete rather than merely narrow. Prefer the full run when you are
unsure what you touched.

## Release

changesets: merge to main → release workflow opens/updates a "Version Packages" PR →
merging that publishes to npm. Never hand-edit CHANGELOG.md.
