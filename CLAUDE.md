# agent-kit

Interactive installer for a portable Claude Code context-discipline kit. Read
`packages/cli/README.md` for the product story. This file is for working on the kit itself.

## Workspace

A pnpm workspace of seven packages. Every path in the Layout section below is relative to
**`packages/cli/`** unless it starts with `packages/`.

- `packages/cli` is `@agent-kit/cli`, the installer. It ships the binary **`agent-kit`**,
  so the package name and the command differ, the same split `@changesets/cli` uses for
  `changeset`. Install is `pnpm add -D @agent-kit/cli`, then `agent-kit <cmd>`. Its core
  ships 15 built-in modules (`src/plan.ts`'s `MODULES` array): `core`, `lint-fix`,
  `session-context`, `rename`, `reviewers`, `debug-session`, `plans`, `orchestrate`,
  `verify-changed`, `ready`, `sweep`, `read-guard`, `regen`, `statusline`,
  `code-cleanliness`.
- Six first-party plugins, each `packages/plugin-<name>`, hold the modules that moved out of
  the core: `plugin-prose`, `plugin-testing`, `plugin-changesets`, `plugin-backlog`,
  `plugin-decisions`, `plugin-persona-auditor`. `src/retired-modules.ts`'s
  `RETIRED_MODULES` maps every retired built-in id to the package that now ships it.
- The workspace root owns repo-wide concerns only: `prettier`, `eslint`, changesets, the
  workflows, `CLAUDE.md`, and the gitignored `.claude/`. Root
  `pnpm build|test|check` delegate with `pnpm -r`. `pnpm lint` and `pnpm lint:fix` run
  `eslint` directly against the whole workspace, since lint lives at the root and no
  package has its own lint script.
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
  - **`test/` holds no tests**, only the shared testing modules, one per artifact: `repo`
    (builds the synthetic repos), `run` (`runCli`, `runScript`, `runIn`), `installed-tree`,
    `doctor-report`, `runner-stub`, `hook-input`, `ctx-builder`, plus `global-setup`. Named
    `test/` and not `__test__/` because the latter means "tests live here" and none do. They
    get **no tests of their own**: every suite that imports one exercises it.
  - Import them via the **`#test/*` alias**, mapped in `vitest.config.ts` (`resolve.alias`, a
    regex prefix so a new module needs no config change) and `tsconfig.json` (`paths`). Not in
    `package.json` `imports`, which would publish a mapping to files the package does not ship.
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

## Commands

- `pnpm build`: clear `dist/` + `payload-dist/` (so a deleted source ships no orphan), `tsc` →
  `dist/`, regenerate the JSON Schema, then `publint`. Required before any `dist/` probe.
- `pnpm check`: `tsc --noEmit` over `src/` + `test/` + colocated `__test__/` dirs.
- `pnpm test`: full suite, including end-to-end init/update/doctor on fixtures.
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
  **`.claude/scripts` still points at BUILD OUTPUT (`payload-dist/`), so a `.mts` edit is NOT
  live until it is compiled.** Run `pnpm dogfood:watch` (a `tsc --watch` on the payload) while
  working on hook scripts, or re-run `pnpm dogfood`. The prose/rules/agents/output-styles/
  reference dirs link straight to each package's `payload/` and are live on save.
  `build:payload` removes `payload-dist/` before compiling, so a deleted `.mts` no longer
  leaves a stale `.mjs` behind. `dogfood:watch` is the exception, since a watch never cleans.
  Run `pnpm dogfood` after deleting a script.

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
- The user always handles `git commit` / `push` / PR-create.

## Cost & verification discipline

- Stage-sized work (≤ a handful of files): implement directly in-context, with no implementation
  subagents. Reserve subagents for genuinely parallel or unbounded work (wide sweeps, migrations).
- Exception, a planned phase under `/orchestrate`: dispatch one scoped `task-worker` per slice and
  review the returned reports. Never pull a worker's diff into the main context.
- Verify with static gates (`pnpm test`, lint) plus a short falsifiable acceptance checklist for
  the user. No browser/screenshot verification unless explicitly asked.
- Changes to generated prose (`src/render.ts`) need a rendered probe, not just a green suite.
  Run `init` against a fixture and read the output. Static tests do not catch a dropped sentence
  boundary.
- On AskUserQuestion timeout, stop and re-ask when the user returns. Never carry tentative
  selections forward.
- Read this file plus targeted greps before fanning out Explore/Plan agents.

## Release

changesets: merge to main → release workflow opens/updates a "Version Packages" PR →
merging that publishes to npm (`NPM_TOKEN` secret required). Never hand-edit CHANGELOG.md.
