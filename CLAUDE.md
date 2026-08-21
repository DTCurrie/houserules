# houserules

<!-- houserules:claude-md start -->

### houserules sections

This block is maintained by `npx houserules update`. Content outside the markers around it
is yours and never touched. For a fuller from-scratch skeleton to compare structure against, see
`.claude/templates/CLAUDE.md.template`, a gitignored reference that `npx houserules update`
restores if absent. For decisions the repo keeps re-deriving on one axis (architecture, API
conventions), instantiate `.claude/templates/rules/GUARDRAIL.md.template` into `.claude/rules/`.

### Recording changes (changesets)

After completing a meaningful change to a package, record a changeset **before the commit**,
via the `/changeset` skill. See that skill for what it does and when to run it.

### Tracking out-of-scope work

Discover a real issue outside the current scope? **Do not fix it inline.** Log it with the
`/backlog-add` skill instead. Prefixes by area: `API` (packages/api/), `CLI` (packages/cli/), `PAYLOAD` (packages/payload/), `PLUGINACCESS` (packages/plugin-accessibility/), `PLUGINBACKLO` (packages/plugin-backlog/), `PLUGINCHANGE` (packages/plugin-changesets/), `PLUGINDECISI` (packages/plugin-decisions/), `PLUGINDESIGN` (packages/plugin-design/), `PLUGINGITHUB` (packages/plugin-github/), `PLUGINPERSON` (packages/plugin-persona-auditor/), `PLUGINPROSE` (packages/plugin-prose/), `PLUGINSVELTE` (packages/plugin-svelte/), `PLUGINTESTIN` (packages/plugin-testing/), `PLUGINTHREE` (packages/plugin-three/), `PLUGINTYPESC` (packages/plugin-typescript/), `TEST` (packages/test/), `PLUGINFIXTUR` (packages/cli/test/plugin-fixture/).

### Recording decisions

Settled a design question that the code does not explain on its own? Record it with the
`/decide` skill. See that skill for the bar a decision has to clear and what a record needs.

### Planning large, multi-phase work

For an implementation too big to hold in one plan, run the `/plan-project` skill. It persists
to `.claude/plans/<name>/`, keeping `ROADMAP.md` current as each phase lands. See the skill
for the full scaffold and when to use it.

### Executing a planned phase

To implement a phase from `.claude/plans/<slug>/`, run `/orchestrate`. See that skill for how
it slices work and reviews it.

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
- Exception, a planned phase under `/orchestrate`: dispatch one scoped `task-worker` per slice
  and review the returned reports. Never pull a worker’s diff into the main context.
- Verify with static gates (tests, typecheck, lint) plus a short falsifiable acceptance checklist
  for the user. No browser/screenshot verification unless explicitly asked.
- Run those gates in order: format first, since it rewrites in place and settles the mechanical
  noise, then lint with autofix so only real problems are left, then typecheck and test. Scope
  each command to the packages you changed. This order is for work you do yourself.
  When subagents are editing in parallel, the fixer runs once after they report, never inside
  one of them, since it rewrites files their siblings still have open.
- **"Done" means every check passed, not that the edits were made.** Report a check that failed
  or never ran, with its output. Never claim success over one you did not see pass.
- Derive empirical constants by parsing the artifact itself, not screenshot-and-iterate loops.
- On AskUserQuestion timeout, stop and re-ask later. Never carry tentative selections forward.
- Read the repo's own docs + targeted greps before fanning out Explore/Plan agents.

### Tool-use efficiency

- `grep -n` to locate, then `Read` with `offset`/`limit`. Never read big files whole.
- Never `git stash` to baseline-check. Use `git diff --name-only` / `git show HEAD:<path>`.
- Pipe long command output through `grep`, and batch related greps into one call.

<!-- houserules:claude-md end -->

Interactive installer for portable Claude Code context discipline. Read
`packages/cli/README.md` for the product story. This file is for working on houserules itself.

## Workspace

A pnpm workspace of sixteen packages. Every path in the Layout section below is relative to
**`packages/cli/`** unless it starts with `packages/`.

- `packages/cli` is `@houserules/cli`, the installer. It ships the binary **`houserules`**,
  so the package name and the command differ, the same split `@changesets/cli` uses for
  `changeset`. Install is `pnpm add -D @houserules/cli`, then `houserules <cmd>`. Its core
  ships 16 built-in modules (`src/plan.ts`'s `MODULES` array): `core`, `lint-fix`,
  `session-context`, `rename`, `reviewers`, `debug-session`, `plans`, `orchestrate`,
  `verify-changed`, `ready`, `sweep`, `read-guard`, `regen`, `statusline`,
  `code-cleanliness`, `ci-settings`.
- `packages/api` is `@houserules/api`, the plugin contract package: action types, module
  definitions, and the `houserules.config.json` schema that plugin authors build against. See
  Layout below for where each shared type lives inside it.
- `packages/payload` is `@houserules/payload`, the nine shared payload libs (`backlog-id`,
  `entry-ledger`, `config`, `ledger-index`, `proc`, `workspaces`, `comment-scan`, `findings`,
  `markdown-segment`) as their own package.
  It ships no modules and installs nothing on its own. A payload script, in the CLI or in a
  plugin, imports one by package name, `@houserules/payload/config`, and the build rewrites
  that specifier to the relative path the flattened `.claude/scripts/lib/` layout needs.
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
  `test` aggregator lists **fifteen** packages, not sixteen, because `@houserules/test` ships
  no `test` script and naming a script that does not exist is a wireit
  error rather than the no-op `pnpm -r` gave you. Root `lint` is also wireit, and `lint:fix`,
  `format`, and `format:check` stay plain scripts. A fixer mutates its own inputs, so caching
  it is wrong, and a repo-wide formatter's input set is `.prettierignore`, which should not be
  restated in `package.json` where the two would drift.
- **`.claude/` stays at the workspace root**, because that is where Claude Code looks, while
  each package's payload lives with that package. `packages/cli/scripts/dogfood-link.mjs`
  bridges the two by seeding this repo's `houserules.config.json`/`settings.json` and running the
  real installer over it, then relinking installed prose back to its payload source.

## Layout

- `src/`: the installer, in TypeScript. The pipeline is detect → plan (declarative actions) →
  preview → apply. May use npm dependencies (@clack/prompts, picocolors, zod). Builds to `dist/`
  (gitignored). Shared types that cross the plugin boundary live in the `@houserules/api`
  contract package, not scattered across `src/`: `Ctx` and `Target` in
  `packages/api/src/ctx.ts` (re-exported from `src/detect.ts`, which stays the sole producer,
  the code that actually builds a `Ctx`), `HouseManifest` in `packages/api/src/manifest.ts`,
  the `Action` union in `packages/api/src/actions.ts`, `ModuleDef`/`Answers` in
  `packages/api/src/module-def.ts`, and the `Settings*`/`Hook*` shapes in
  `packages/api/src/merge-settings.ts`. What stays local to `src/`: `Effect`/`PlanResult`/
  `PruneResult` in `src/plan.ts`, `Apply*` in `src/apply.ts`, and `Flags`/`EXIT` in
  `src/cli-contract.ts`. `packages/api/src/config.ts` is the zod schema for
  `houserules.config.json`.
- `schema/houserules.config.schema.json` is **generated** from that zod schema by `pnpm run schema`.
  Never hand-edit it. `src/core/__test__/config.test.ts` fails when it falls out of sync.
- `payload/`: everything copied into user repos. Scripts are authored as `.mts` and compiled
  to `payload-dist/scripts/*.mjs`. The prose dirs (`skills/`, `agents/`, `rules/`,
  `templates/`) are copied through verbatim. `output-styles/` moved to `plugin-prose`
  along with the `output-prose` module, so it is no longer one of this package's prose dirs.
  **`payload-dist/` is what
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
    (one file per doctor check), `payload/scripts/__test__/`, and `payload/__test__/` for the
    two invariants over the whole built tree (`dependencies`, `execution`). The shared libs'
    own tests live at `packages/payload/payload/scripts/lib/__test__/` in the standalone
    `@houserules/payload` package, not under `packages/cli/payload/scripts/lib/`, which does
    not exist.
  - **The shared testing modules live in `packages/test`, published as `@houserules/test`**, one
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
- **Most packages use that same two-tsconfig split, and where both jobs exist one tsconfig may
  never do both.** Two are exceptions, and they are exceptions for a reason rather than by drift.
  `packages/payload` has no `src/` at all, so it has no `tsconfig.build.json`, and its
  `tsconfig.json` extends `tsconfig.payload.json`, the reverse of the usual direction.
  `packages/test` has a single `tsconfig.json` doing both jobs, because it ships no payload and
  its consumers import it through `#test/*`. Check which shape a package has before writing a
  path into a brief. A slice brief written from the old wording sent a worker to edit a
  `tsconfig.build.json` that does not exist.
  `tsconfig.build.json` is the EMIT config: it excludes tests so they stay out of `dist/`.
  `tsconfig.json` is the CHECK config: it `extends` the build one, sets `noEmit` and
  `rootDir: "."`, clears the exclude with `exclude: []`, and lists **both** test locations in
  `include`, `src/**/*.ts` and `payload/**/__test__/**/*.ts`. Drop the payload glob and the
  hook-script suites silently go unchecked, which is not hypothetical: four packages had
  drifted off this pattern and `pnpm check` was skipping five suites entirely. Vitest strips
  types rather than checking them, so nothing else would have caught it. A package's wireit
  `build.files` names `tsconfig.build.json` and its `check.files` names both.
- **A package that ships payload scripts has a THIRD tsconfig, and `check` must run it too.**
  `tsconfig.payload.json` compiles `payload/**/*.mts` to `payload-dist/`, and its options are
  genuinely different: its own `rootDir` and `outDir`. Those cannot be folded into the check config,
  so `check` runs both projects:
  `tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.payload.json`. Its `files` names
  `payload/**/*.mts` and `tsconfig.payload.json`, and its `dependencies` names
  `../payload:build`, without which a `@houserules/payload/*` import resolves nothing. **No
  plugin carries a `rootDirs` line any more.** Six of them did, each pairing `./payload/scripts` with
  `../cli/payload-dist/scripts`, a relative path into a sibling's build output that existed only
  inside this monorepo and that a third-party author had no way to write. Package-name imports plus
  the `houserules-payload` rewrite replaced all six. Do not add one back.
  Not hypothetical either: six plugins ran `check` over `src/` alone, so 26 payload sources
  including the largest script in the workspace were never typechecked by it. `build` caught them,
  which is why nothing was broken, but `check` is the gate that runs first and it was reporting
  green on files it had not read.

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
- `pnpm dogfood`: build the payload, then wire this repo to run houserules on itself by running the real
  installer over itself. `packages/cli/scripts/dogfood-link.mjs` seeds `.claude/houserules.config.json`
  and `.claude/settings.json` (rewritten every run, since its `plugins` list and the module set
  the script passes to `init` are two halves of one definition), then shells out to
  `node dist/cli.js init --yes` with an explicit `--modules` list and `--module-option` flags,
  the same plan/apply pipeline a user's `init` runs. A relink pass runs after: any manifest-
  tracked destination under `skills/`, `agents/`, `output-styles/`, `rules/`, or `reference/`
  whose installed bytes are an exact, unique match for one payload source gets swapped back to
  a symlink at that source, so editing a payload rule or skill shows up in `.claude/`
  immediately, with no rebuild and no re-run of this script. Idempotent, so re-run after
  pulling.
  **`.claude/scripts/` stays a COPY taken from `payload-dist/`, never relinked** (a symlinked
  script cannot resolve `./lib/` from the symlink's real path), so a `.mts` edit has to be
  compiled AND re-copied before it is live. The two `appendBody` rules also stay real files,
  since their installed bytes carry a routing tail no payload source has byte-for-byte.
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
  (houserules.config.json, CLAUDE.md, reviewer drafts, .changeset/config.json) belong to the user, so
  never overwrite them.
- Ownership can split INSIDE one file, and there are two shapes of that. A `region` action means
  houserules owns a marker-delimited block in a file the user owns. A `body` action is the mirror:
  houserules owns everything below the closing `---` and the user owns the frontmatter above it.
  Rules are the `body` case, because houserules' own advise text tells users to trim a rule's
  `paths:` to their repo. Both record a hash of the part the KIT wrote, never of the whole file,
  and `update` splices rather than overwrites. Adding a third split needs a reason this good.
- `.claude/scripts/` is **generated, not source**: self-gitignored on init, and installs that
  committed it are migrated by `update` (`git rm --cached` only, working tree untouched, never
  committed). `scripts.commit: true` opts back into committing them. Because the scripts may be
  absent on a fresh clone while `settings.json` is committed, `hookCommand()` wraps every hook in
  a file-existence guard that `exec`s node. `exec` is load-bearing, since a plain `node` would
  let any non-zero exit fall through to the fallback echo and swallow the code (changeset-check
  exits 2 on purpose).
- **Payload code crosses packages by PACKAGE NAME, and the build rewrites it.** Decision
  `AGENTKIT-deb26c`. Any payload file, script or lib, reaches a shared lib as
  `import { nowIso } from '@houserules/payload/entry-ledger'`, for values and types alike. There
  is one form, not two. The nine shared libs live in the standalone `@houserules/payload` package:
  `backlog-id`, `entry-ledger`, `config`, `ledger-index`, `proc`, `workspaces`, `comment-scan`,
  `findings`, and `markdown-segment`. Anything else under `./lib/` is the package's own and
  stays a relative import.
  - **`houserules-payload` is what makes it safe**, a bin the CLI publishes that each plugin runs
    after its `tsc`. It rewrites those specifiers in the emitted `.mjs` to the relative form the
    flattened `.claude/scripts/` layout needs, and records what it rewrote in
    `payload-dist/payload-imports.json`. Install reads that sidecar and copies each named lib from
    `@houserules/payload`'s own `payload-dist`, so a plugin no longer relies on the `core` module
    happening to ship what its scripts import. A plugin declares nothing and cannot forget.
  - **Never let a bare `@houserules/*` specifier reach an emitted `.mjs`.** The payload is a copy
    target, not a dependency: it is copied into a user's repo and runs standalone on bare node, on
    every hook. `payload/__test__/dependencies.test.ts` fails on a surviving specifier, and that
    test is the guard now, replacing the types-only exports map that used to fail such an import at
    runtime by accident.
  - **A value a lib needs is still passed in.** `readGateInputs(ledgerDirectory, autoSync)` is the
    pattern. The script is the composition root, and a pure lib should not reach for config. That
    is a design rule about coupling, not a resolution limit.
  - The old rule here said a payload lib could not import a CLI lib. That was measured false on two
    packages, and a name collision fails loudly at build with TS2305 rather than shadowing
    silently. Do not reintroduce the prohibition.
- A lib the CLI's OWN scripts import must still be listed in `src/modules/core.ts`'s copy manifest.
  A plugin's cross-package imports are derived from its sidecar instead, so only the CLI's own
  manifest is hand-maintained now.
- Two readers of houserules.config.json, one shape: the CLI validates strictly via zod
  (`packages/api/src/config.ts`), and the payload reads it defensively and **dependency-free**
  (`loadConfigSafe()`). They share only the inferred `HouseConfig` type. Never make the payload
  import zod. `payload/__test__/dependencies.test.ts` enforces this.
- init never runs package-manager installs and never touches settings.local.json.
- Managed regions: houserules maintains its own marker-delimited block inside files the user
  owns (CLAUDE.md, and `.prettierignore` when prettier is detected). It writes ONLY between
  the markers, and bytes outside them are never modified. Those paths are in
  `SHARED_HOST_FILES`: never created wholesale, never pruned, and their manifest hash covers
  the region BODY, not the file.
- houserules' installed files must stay out of the host repo's formatter. Everything under
  `.claude/` that the manifest tracks by content hash is byte-fragile, so a repo-wide
  `prettier --write` rewrites it and `update` then reads the whole install as local edits
  and skips it. That is silent, which is why `src/modules/prettier-guard.ts` writes the
  `.prettierignore` block rather than the README documenting it. It runs unconditionally
  after every module's `plan()` in `src/plan.ts`, not scoped to `core`, and derives the
  protected `.claude/` subtrees dynamically from the actions the plan actually produced
  (`protectedSubtrees()`), rather than a hand-maintained constant. A new kit-owned subtree
  under `.claude/` is covered automatically, the day its action lands.
- Prose houserules ships (payload skills, agents, rules, templates, and the CLAUDE.md region
  `src/render.ts` generates) follows `packages/plugin-prose/payload/rules/prose-voice.md`:
  plain sentences, no semicolons, no em dash where a period or comma works. Frontmatter
  `description:` fields are the skill-routing signal, so keep every trigger term when
  rewording one.
- No catch-all files, per `payload/rules/code-cleanliness.md` (in `packages/cli`), which the
  houserules ships and this repo obeys. There is no `types.ts`, `shared.ts`, `utils.ts`,
  `constants.ts`, or `helpers.ts` anywhere in any package's `src/`. A type belongs to the
  module that produces it, and genuinely shared code gets a module named for its job.
  `@houserules/api` is not an exception carved out of this rule: it is a deliberate published
  contract package, the one place a plugin author's code and this installer's code both
  compile against, not a dumping ground reached for out of laziness. A file in it still has
  to be named for what it holds (`actions.ts`, `manifest.ts`, `merge-settings.ts`), never
  `types.ts`. Do not reintroduce a per-package catch-all.
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
  `HouseError` handler. `assertNoRetiredModules` is that guard: it has to see the recorded
  module set before a plan is computed from it, and it throws `HouseError` so the command
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
