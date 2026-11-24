# PLAN: ignored-payload

**Created:** 2026-11-20 · **Status:** see [ROADMAP.md](ROADMAP.md)

## Goal

A houserules install goes stale quickly, and refreshing it puts a wall of generated files in the
host repo's diff. Both come from one cause: 66 installed files (skills, rules, reference, agents,
output styles) and the manifest are committed, so an update is a change to the working tree that
someone has to review and commit. This plan makes git track only what the user decided, makes
everything houserules generates local and ignored, and then lets the install sync itself to the
pinned CLI version without anyone running a command.

## Approach

Decisions the user locked on 2026-11-20:

- **Pinned, with automatic sync.** The lockfile pin of `@houserules/cli` is the version of record. A
  hook compares the installed CLI version with what the install was last written from and runs the
  update when they differ or files are missing. No floating `@latest`.
- **Hand edits go through eject.** `houserules eject <file>` takes a file out of the ignore list
  and records it in the config. From then on it is tracked and behaves as today's `yours` and
  `conflict`. No overrides directory.
- **Existing installs migrate by default.** `update` untracks with `git rm --cached`, staged only,
  as the scripts migration did. `payload.commit: true` keeps today's committed mode.

Three more, settled by the user on 2026-11-20 after the plan review:

- **The version check is on by default.** Someone running Claude Code is online anyway.
- **houserules writes the `prepare` script itself** if phase 1 shows one is needed. A script the
  user has to copy and paste is an extra step the tool should not hand them.
- **Migration starts with a pre-verify pass** that reads everything, writes nothing, and on any
  unsafe condition stops and asks the user how to proceed, with options.

Decisions this plan adds, each open to the user at handoff:

- **The enabled module set moves into `houserules.config.json`.** Today it lives only in the
  manifest (`manifest.modules`, read at `packages/cli/src/commands/update.ts:227`), and `update`
  stops when there is no manifest. An ignored manifest means a fresh clone has none, so the tracked
  config has to be enough to rebuild the install.
- **One managed block in `.claude/.gitignore` lists every ignored dest by path.** Users keep their
  own skills, rules and agents in the same directories, so a `*` per directory would hide their
  files. `.claude/scripts/` and `.claude/templates/` keep their existing `*` files.
- **A rule's `paths:` move into the config.** The README tells users to trim them, so they are the
  most common hand edit and should not cost an eject.
- **The bootstrap never downloads.** A fresh clone's hook runs the locally installed binary only.
  With no `node_modules` it prints the install hint and exits 0. `npx houserules` with nothing
  installed would ask the registry for a package this project does not own.
- **Sync never overwrites a local edit to an ignored file.** With the manifest local, a hash
  mismatch on an ignored file is a real edit on this machine. Sync skips it and names `eject`.

Tracked after the change: `.claude/houserules.config.json`, `.claude/settings.json`,
`.claude/.gitignore`, the CLAUDE.md region, ejected files, and the lockfile pin.

The phases run as one chain, in order. Phases 2 to 7 all write `packages/api/src/config.ts` and the
CLI planner, so none declares a Domain and none runs beside another.

Non-goals: one hook dispatcher per event to stop `settings.json` churn, and distribution as a native
Claude Code plugin. Phase 8 logs both to the backlog.

## Phases

1. **probes**: settle load order, worktree and no-`node_modules` behavior, and `@import` of an
   ignored file → [phase-1-probes.md](phase-1-probes.md)
2. **ignore-core**: a fresh `init` leaves only the tracked set in `git status`, and the config
   alone rebuilds the install → [phase-2-ignore-core.md](phase-2-ignore-core.md)
3. **auto-sync**: a fresh clone or a bumped pin heals itself at session start →
   [phase-3-auto-sync.md](phase-3-auto-sync.md)
4. **eject**: `houserules eject` and config-owned rule `paths:` →
   [phase-4-eject.md](phase-4-eject.md)
5. **migrate**: `update` converts a committed install, keeping every edit →
   [phase-5-migrate.md](phase-5-migrate.md)
6. **version-notice**: a daily-cached "newer version available" line →
   [phase-6-version-notice.md](phase-6-version-notice.md)
7. **import-region**: the CLAUDE.md region shrinks to one stable `@import` line, if phase 1 says
   it works → [phase-7-import-region.md](phase-7-import-region.md)
8. **closeout**: gates, checklist, PR description, backlog rows →
   [phase-8-closeout.md](phase-8-closeout.md)

## Key files & interfaces

- `packages/cli/src/plan.ts`: `classifyWrite` and its `isGenerated` escape,
  `SELF_GITIGNORED_GENERATED_DIRS`, `generatedDirsIn`. The scripts precedent this plan generalizes.
- `packages/cli/src/modules/core.ts` and `packages/cli/src/modules/copy-actions.ts`: where the
  `.gitignore` writes for scripts and templates are built.
- `packages/cli/src/commands/update.ts`: the no-manifest stop at line 351, `untrackAndReport`, and
  the scripts untrack migration near line 455.
- `packages/cli/src/core/drift.ts`: `FileStatus`, `FIXABLE`, `FORCE_ONLY`, `isLocalEdit`.
- `packages/api/src/hook-wiring.ts`: `hookCommand()` and its three fallbacks.
- `packages/api/src/config.ts`: the config schema. `scripts.commit` is the opt-out precedent. The
  CLI's JSON Schema regenerates from it with `pnpm run schema`.
- `packages/api/src/manifest.ts`: `HouseManifest`.
- `packages/cli/src/commands/doctor/install-integrity.ts`: the stray-tracked-file checks.
- `packages/cli/src/core/claude-md-region.ts`: the managed region phase 7 shrinks.
- `packages/cli/README.md`, sections "`.claude/scripts/` is generated, not source", "Drift" and
  "Rules: you own the frontmatter": the user-facing story each phase updates as it lands.
- Read `docs/payload.md` before any payload script work and `docs/testing.md` before any test.
