# agent-kit

<!-- agent-kit:claude-md start -->

### agent-kit sections

This block is maintained by `npx agent-kit update`. Content outside the markers around it
is yours and never touched. For a fuller from-scratch skeleton to compare structure against, see
`.claude/kit-templates/CLAUDE.md.template`, a gitignored reference that `npx agent-kit update`
restores if absent.

### Recording changes (changesets)

After completing a meaningful change to a package, record a changeset **before the commit**.
Run the `/changeset` skill, or spawn the `changeset-writer` agent. It inspects the diff,
picks patch/minor/major per package, and writes `.changeset/*.md` via
`node .claude/scripts/changeset-write.mjs`. Never hand-edit `CHANGELOG.md`, which releases
generate from changesets (`changeset version`). If nothing user-facing changed, record
that too: `node .claude/scripts/changeset-write.mjs --empty --summary "<why no release>"`.

### Conventions

- **The user always handles `git commit` / `push` / PR-create.** Describe what is ready and stop.
  (Enforced by `.claude/scripts/guard-bash.mjs`.)
- **Edit from the file's current bytes.** Re-read before editing when your view of it is
  second-hand (an earlier snapshot, a build or lint error, another tool's output) or the user may
  have it open. A tool's report and the file on disk can disagree within seconds.
- **Do not rewrite what is not yours to change.** When the user presents a file as their own
  finished work, or has it open mid-edit, surface the problem and let them decide.

### Cost & verification discipline

- Stage-sized work (≤ a handful of files): implement directly in-context, with no implementation
  subagents. Reserve subagents for genuinely parallel or unbounded work (wide sweeps, migrations).
- Verify with static gates (tests, typecheck, lint) plus a short falsifiable acceptance checklist
  for the user. No browser/screenshot verification unless explicitly asked.
- Run those gates in order: format first, since it rewrites in place and settles the mechanical
  noise, then lint with autofix so only real problems are left, then typecheck and test. Scope
  each command to the packages you actually changed.
- **"Done" means every check passed, not that the edits were made.** Report a check that failed
  or never ran, with its output. Never claim success over one you did not see pass.
- Derive empirical constants by parsing the artifact itself, not screenshot-and-iterate loops.
- On AskUserQuestion timeout, stop and re-ask later. Never carry tentative selections forward.
- Read the repo's own docs + targeted greps before fanning out Explore/Plan agents.

### Tool-use efficiency

- `grep -n` to locate, then `Read` with `offset`/`limit`. Never read big files whole.
- Never `git stash` to baseline-check. Use `git diff --name-only` / `git show HEAD:<path>`.
- Pipe long command output through `grep`, and batch related greps into one call.

<!-- agent-kit:claude-md end -->

Interactive installer for a portable Claude Code context-discipline kit. Read
`packages/cli/README.md` for the product story. This file is for working on the kit itself.

## Workspace

A pnpm workspace of fourteen packages. Every path in the Layout section below is relative to
**`packages/cli/`** unless it starts with `packages/`.

- `packages/cli` is `@agent-kit/cli`, the installer. It ships the binary **`agent-kit`**,
  so the package name and the command differ, the same split `@changesets/cli` uses for
  `changeset`. Install is `pnpm add -D @agent-kit/cli`, then `agent-kit <cmd>`. Its core
  ships 16 built-in modules (`src/plan.ts`'s `MODULES` array): `core`, `lint-fix`,
  `session-context`, `rename`, `reviewers`, `debug-session`, `plans`, `orchestrate`,
  `verify-changed`, `ready`, `sweep`, `read-guard`, `regen`, `statusline`,
  `code-cleanliness`, `ci-settings`.
- Twelve first-party plugins, each `packages/plugin-<name>`. Six hold modules that moved out of
  the core: `plugin-prose`, `plugin-testing`, `plugin-changesets`, `plugin-backlog`,
  `plugin-decisions`, `plugin-persona-auditor`. Six were authored as plugins and were never
  in the core: `plugin-accessibility`, `plugin-typescript`, `plugin-three`, `plugin-svelte`,
  `plugin-design`, `plugin-github`.
  `src/retired-modules.ts`'s
  `RETIRED_MODULES` maps every retired built-in id to the package that now ships it.
- The workspace root owns repo-wide concerns only: `prettier`, `eslint`, changesets, the
  workflows, `CLAUDE.md`, and the gitignored `.claude/`. Root `pnpm build|test|check` are
  wireit aggregators that depend on each package's script by path, replacing `pnpm -r`. The
  `test` aggregator lists **twelve** packages, not fourteen, because `@agent-kit/test` and
  `plugin-testing` ship no `test` script and naming a script that does not exist is a wireit
  error rather than the no-op `pnpm -r` gave you. Root `lint` is also wireit, and `lint:fix`,
  `format`, and `format:check` stay plain scripts. A fixer mutates its own inputs, so caching
  it is wrong, and a repo-wide formatter's input set is `.prettierignore`, which should not be
  restated in `package.json` where the two would drift.
- **`.claude/` stays at the workspace root**, because that is where Claude Code looks, while
  each package's payload lives with that package. `scripts/dogfood-link.mjs` bridges the two.

## Layout

- `src/`: the installer, in TypeScript. The pipeline is detect → plan (declarative actions) →
  preview → apply. May use npm dependencies (@clack/prompts, picocolors, zod). Builds to `dist/`
  (gitignored). There is no central type module. Every shared type lives with the code that
  produces it: `Ctx` and `Target` in `src/detect.ts`, `Effect`/`PlanResult`/`PruneResult` in
  `src/plan.ts`, the `Settings*` and `Hook*` shapes in `src/merge-settings.ts`, `Apply*` in
  `src/apply.ts`, `KitManifest` in `src/core/manifest.ts`, the `Action` union in
  `src/actions.ts`, `ModuleDef`/`Answers` in `src/module-def.ts`, and `Flags`/`EXIT` in
  `src/cli-contract.ts`. `src/core/config.ts` is the zod schema for `kit.config.json`.
- `schema/kit.config.schema.json` is **generated** from that zod schema by `pnpm run schema`.
  Never hand-edit it. `src/core/__test__/config.test.ts` fails when it falls out of sync.
- `payload/`: everything copied into user repos. Scripts are authored as `.mts` and compiled
  to `payload-dist/scripts/*.mjs`. The prose dirs (`skills/`, `agents/`, `rules/`,
  `output-styles/`, `kit-templates/`) are copied through verbatim. **`payload-dist/` is what
  ships and what `payloadPath()` reads.** Zero runtime dependencies, node builtins only, POSIX
  shells, enforced by `payload/__test__/dependencies.test.ts` (imports) and `payload/__test__/execution.test.ts`
  (actually executing each emitted script on bare node). Hook scripts must never crash: config
  via `loadConfigSafe()`, exit 0 on any failure path.
- Tests live in a `__test__/` **beside the code they are about**, per
  `packages/plugin-testing/payload/rules/testing.md` which this repo dogfoods. The split is by SUBJECT, not by unit-versus-e2e: a fixture-driven
  CLI test is still a test of its one subject, so `src/commands/__test__/modules.test.ts` holds
  both the pure `parseRequested` cases and the ones that drive the command against a real tree.
  Never add a `.e2e.test.ts` tier. If a file gets unwieldy, split it by CONCERN.
  - **The filename names the unit, and every `describe` in it is about that unit.** A file named
    for a theme is a grouping, and a grouping hides which unit is covered. `src/**/__test__/`,
    `src/modules/__test__/` (named for the module it covers), `src/commands/doctor/__test__/`
    (one file per doctor check), `payload/scripts/__test__/`, `payload/scripts/lib/__test__/`,
    and `payload/__test__/` for the two invariants over the whole built tree (`dependencies`,
    `execution`).
  - **The shared testing modules live in `packages/test`, published as `@agent-kit/test`**, one
    per artifact: `repo` (builds the synthetic repos), `run` (`runCli`, `runScript`, `runIn`),
    `installed-tree`, `doctor-report`, `runner-stub`, `hook-input`, plus `global-setup`. It holds
    **no tests of its own**: every suite that imports one exercises it. `vitest` is a
    peerDependency, so its tarball ships an import of it on purpose.
  - Import them via the **`#test/*` alias**, which resolves into that package. Mapped in each
    consumer's `vitest.config.ts` (`resolve.alias`, a regex prefix so a new module needs no
    config change) and `tsconfig.json` (`paths`). `packages/cli` keeps one local module,
    `ctx-builder`, under its own `test/`, so its config maps `#test/ctx-builder` ahead of the
    general prefix. Not in `package.json` `imports`, which would publish a mapping to files the
    package does not ship.
  - Stage with `useInstalledRepo()`, which copies a cached post-`init` snapshot, rather than
    running `init` in a test that is not about `init`. Otherwise one `init` regression fails
    twenty unrelated suites and names the wrong thing. `useRepo()` gives a bare repo.
  - Test files carry **no comments and no file header**. The `describe` name, the `it` name, and
    a named helper are the three places meaning goes.
- **Tests must never reach the published package**, and a green suite will not catch it.
  `tsconfig.build.json` excludes `src/**/__test__/**` and `tsconfig.payload.json` excludes
  `payload/**/__test__/**`, since `dist/` and `payload-dist/` are both `files` entries. A
  shipped test would carry a `vitest` import into a user's install. `tsconfig.json` clears the
  inherited exclude so `pnpm check` still typechecks them. Verify with a real
  `pnpm pack` and grep the tarball, not with `find` over `dist/`.
- **Every package uses that same two-tsconfig split, and one tsconfig may never do both jobs.**
  `tsconfig.build.json` is the EMIT config: it excludes tests so they stay out of `dist/`.
  `tsconfig.json` is the CHECK config: it `extends` the build one, sets `noEmit` and
  `rootDir: "."`, clears the exclude with `exclude: []`, and lists **both** test locations in
  `include`, `src/**/*.ts` and `payload/**/__test__/**/*.ts`. Drop the payload glob and the
  hook-script suites silently go unchecked, which is not hypothetical: four packages had
  drifted off this pattern and `pnpm check` was skipping five suites entirely. Vitest strips
  types rather than checking them, so nothing else would have caught it. A package's wireit
  `build.files` names `tsconfig.build.json` and its `check.files` names both.

## Commands

- Every `build`, `check`, and `test` script runs through **[wireit](https://github.com/google/wireit)**,
  which owns the dependency graph and the incremental skipping. Each script declares its
  `dependencies`, its input `files`, and its `output` in a `wireit` block in the same
  `package.json`. Two consequences worth internalizing. A script whose inputs are unchanged is
  **skipped**, so a second `pnpm test` costs about 0.3s rather than 26s, and a `--filter`ed
  command pulls that package's upstream builds in on its own. And a `files` glob that misses a
  real input fails **silently**, by skipping work that should have run, so add the glob the
  same day you add the input.
- `pnpm build`: `tsc` → `dist/`, assemble `payload-dist/`, regenerate the JSON Schema, then
  `publint`. Wireit's declared `output` plus its default `clean: true` is what guarantees a
  deleted source ships no orphan, replacing the old `rm -rf` prefixes. Required before any
  `dist/` probe.
- `pnpm check`: `tsc --noEmit` over `src/` + `test/` + colocated `__test__/` dirs.
- `pnpm test`: full suite, including end-to-end init/update/doctor on fixtures. A bare `npx
vitest`, outside the script, now needs a prior `pnpm build`, since the shared vitest global
  setup no longer builds the CLI itself.
- `node packages/cli/dist/cli.js init --yes --dry-run <repo>`: safe manual probe against any
  repo.
- `pnpm change`: record a changeset. Required for any user-visible change, and dogfooded.
- `pnpm lint` / `pnpm lint:fix`: run from the workspace root only. `eslint.config.mjs` lives
  at the root with `packages/*/` globs, and no package defines its own `lint` script.
- `pnpm dogfood`: build the payload, then wire this repo's `.claude/` (gitignored) to run its
  own hooks/skills/agents. `scripts/dogfood-link.mjs` discovers every workspace package that
  has a `payload/` dir and assembles each `.claude/<surface>/` directory from **per-entry
  symlinks** across all of them, not one directory symlink, because `.claude/rules/` now
  draws from the CLI plus the prose and testing plugins at once. It throws if two packages
  contribute the same entry name. Idempotent, so re-run after pulling.
  **`.claude/scripts` is a COPY taken from `payload-dist/`, not a symlink** (a linked script
  cannot resolve `./lib/` from the symlink's real path), so a `.mts` edit has to be compiled
  AND re-copied before it is live. The prose/rules/agents/output-styles/reference dirs link
  straight to each package's `payload/` and are live on save.
- `pnpm dogfood:watch`: `WIREIT_WATCH=true` over the `dogfood` graph, so editing or adding a
  payload `.mts` recompiles it and re-copies it into `.claude/scripts/` with no second command.
  It covers every package that ships payload scripts, not just the CLI. This replaced a bare
  `tsc --watch` on the payload, which compiled to `payload-dist/` and stopped, leaving the copy
  under `.claude/scripts/` stale. Anyone following the old instructions was editing a hook and
  testing the previous version of it.
  **DELETING a script is still not covered. Re-run `pnpm dogfood`.** The watcher does fire, but
  that run treats `build:payload` as fresh and does not re-restore its output, so the orphaned
  `.mjs` survives in both `payload-dist/` and `.claude/scripts/` until a new wireit process
  runs. Verified, not assumed. Outside the watch a deletion is handled correctly, because
  wireit restores the cached output for the reverted fingerprint.

## Rules

- The plan/apply boundary is load-bearing: modules return actions, only `src/apply.ts`
  writes (through `src/core/fs-target.ts`), and dry-run renders the same computed effects. Never
  add filesystem writes elsewhere.
- Kit-owned vs user-owned: copies and writes are manifest-tracked and update-refreshable. Seeds
  (kit.config.json, CLAUDE.md, reviewer drafts, .changeset/config.json) belong to the user, so
  never overwrite them.
- Ownership can split INSIDE one file, and there are two shapes of that. A `region` action means
  the kit owns a marker-delimited block in a file the user owns. A `body` action is the mirror:
  the kit owns everything below the closing `---` and the user owns the frontmatter above it.
  Rules are the `body` case, because the kit's own advise text tells users to trim a rule's
  `paths:` to their repo. Both record a hash of the part the KIT wrote, never of the whole file,
  and `update` splices rather than overwrites. Adding a third split needs a reason this good.
- `.claude/scripts/` is **generated, not source**: self-gitignored on init, and installs that
  committed it are migrated by `update` (`git rm --cached` only, working tree untouched, never
  committed). `scripts.commit: true` opts back into committing them. Because the scripts may be
  absent on a fresh clone while `settings.json` is committed, `hookCommand()` wraps every hook in
  a file-existence guard that `exec`s node. `exec` is load-bearing, since a plain `node` would
  let any non-zero exit fall through to the fallback echo and swallow the code (changeset-check
  exits 2 on purpose).
- Every shared lib a payload script imports must be listed in `src/modules/core.ts`'s copy
  manifest. A script installed without its lib fails with ERR_MODULE_NOT_FOUND in the user's repo,
  which no unit test catches.
- Two readers of kit.config.json, one shape: the CLI validates strictly via zod
  (`src/core/config.ts`), and the payload reads it defensively and **dependency-free**
  (`loadConfigSafe()`). They share only the inferred `KitConfig` type. Never make the payload
  import zod. `payload/__test__/dependencies.test.ts` enforces this.
- init never runs package-manager installs and never touches settings.local.json.
- Managed regions: the kit maintains its own marker-delimited block inside files the user
  owns (CLAUDE.md, and `.prettierignore` when prettier is detected). It writes ONLY between
  the markers, and bytes outside them are never modified. Those paths are in
  `SHARED_HOST_FILES`: never created wholesale, never pruned, and their manifest hash covers
  the region BODY, not the file.
- The kit's installed files must stay out of the host repo's formatter. Everything under
  `.claude/` that the manifest tracks by content hash is byte-fragile, so a repo-wide
  `prettier --write` rewrites it and `update` then reads the whole install as local edits
  and skips it. That is silent, which is why `src/modules/prettier-guard.ts` writes the
  `.prettierignore` block rather than the README documenting it. It belongs to `core` and not
  to `lint-fix`, even though that module's Stop hook is the usual way the formatter gets
  dragged across `.claude/`: the fragility is a property of the install, and `lint-fix` does
  not even enable itself in a repo with no fix script. A new kit-owned subtree under
  `.claude/` belongs in `PRETTIERIGNORE_BODY` the same day it is added.
- Prose the kit ships (payload skills, agents, rules, templates, and the CLAUDE.md region
  `src/render.ts` generates) follows `packages/plugin-prose/payload/rules/prose-voice.md`:
  plain sentences, no semicolons, no em dash where a period or comma works. Frontmatter
  `description:` fields are the skill-routing signal, so keep every trigger term when
  rewording one.
- No catch-all files, per `payload/rules/code-cleanliness.md` (in `packages/cli`), which the
  kit ships and this repo obeys. There is no `types.ts`, `shared.ts`, `utils.ts`,
  `constants.ts`, or `helpers.ts`
  anywhere in `src/`. A type belongs to the module that produces it, and genuinely shared code
  gets a module named for its job. Do not reintroduce one.
- `doctor` is an orchestrator over independent checks. Each check in `src/commands/doctor/`
  is a pure-ish function of `(root, ctx, flags)` returning `{ findings, readouts }`, and
  `src/commands/doctor.ts` only sequences them and rolls the severity up to an exit code.
  Order matters in two places. `checkConfigValidity` runs first and is a gate: a config the
  schema rejects means every later check would read fields it cannot trust, and `--fix` would
  plan writes from it, so `doctor()` reports the schema problems and returns exit 2 without
  running anything else. `reconcileDrift` runs last because `--fix` writes, and every check
  before it must see the tree as the user left it. Add a new check as a new file, never as
  another branch inside `doctor()`.
- A plugin's payload actions must resolve inside its OWN package. The repo-root
  `scripts/probe-plugin.mjs` loads a plugin through the real resolver and fails any action
  whose `src` escapes the package directory, which is the failure a build alone will not
  catch.
- `src/retired-modules.ts`'s `RETIRED_MODULES` entries are permanent. Removing one re-arms a
  silent prune for any repo that upgrades the CLI without also installing the plugin the
  module moved to: `computePrune` deletes any manifest dest the current plan no longer
  produces, and a removed entry stops that from erroring first.
- Any guard that prevents a prune must run before `computeEffects` and inside the command's
  `KitError` handler. `assertNoRetiredModules` is that guard: it has to see the recorded
  module set before a plan is computed from it, and it throws `KitError` so the command
  aborts with nothing written rather than silently deleting the retired module's files.
- **Edit from the file's current bytes.** Re-read before editing when your view of it is
  second-hand (an earlier snapshot, a build or lint error, another tool's output) or the user may
  have it open. A tool's report and the file on disk can disagree within seconds.
- **Do not rewrite what is not yours to change.** When the user presents a file as their own
  finished work, or has it open mid-edit, surface the problem and let them decide.
- The user always handles `git commit` / `push` / PR-create.

## Cost & verification discipline

- Stage-sized work (≤ a handful of files): implement directly in-context, with no implementation
  subagents. Reserve subagents for genuinely parallel or unbounded work (wide sweeps, migrations).
- Exception, a planned phase under `/orchestrate`: dispatch one scoped `task-worker` per slice and
  review the returned reports. Never pull a worker's diff into the main context.
- Verify with static gates (`pnpm test`, lint) plus a short falsifiable acceptance checklist for
  the user. No browser/screenshot verification unless explicitly asked.
- Run those gates in order: `pnpm format` first, since it rewrites in place and settles the
  mechanical noise, then `pnpm lint:fix` so only real problems are left, then `pnpm check` and
  `pnpm test`. Scope each to the packages you changed (`pnpm --filter <pkg>`), which under
  wireit also pulls in that package's upstream builds, so the scoped run is complete rather
  than merely narrow. The unscoped gates are cheap too now, since anything unchanged is
  skipped, so prefer the full run when you are unsure what you touched.
- **"Done" means every check passed, not that the edits were made.** Report a check that failed or
  never ran, with its output. Never claim success over one you did not see pass.
- Changes to generated prose (`src/render.ts`) need a rendered probe, not just a green suite.
  Run `init` against a fixture and read the output. Static tests do not catch a dropped sentence
  boundary.
- On AskUserQuestion timeout, stop and re-ask when the user returns. Never carry tentative
  selections forward.
- Read this file plus targeted greps before fanning out Explore/Plan agents.

## Release

changesets: merge to main → release workflow opens/updates a "Version Packages" PR →
merging that publishes to npm (`NPM_TOKEN` secret required). Never hand-edit CHANGELOG.md.
