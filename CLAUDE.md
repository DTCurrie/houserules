# claude-kit

npm-published interactive installer (`npx claude-kit init`) for a portable Claude Code
context-discipline kit. Read README.md for the product story. This file is for working on
the kit itself.

## Layout

- `src/`: the installer, in TypeScript. The pipeline is detect → plan (declarative actions) →
  preview → apply. May use npm dependencies (@clack/prompts, picocolors, zod). Builds to `dist/`
  (gitignored). `src/types.ts` is the shared model every module and command is typed against, and
  `src/core/config.ts` is the zod schema for `kit.config.json`.
- `schema/kit.config.schema.json` is **generated** from that zod schema by `pnpm run schema`.
  Never hand-edit it. `src/core/__test__/config.test.ts` fails when it falls out of sync.
- `payload/`: everything copied into user repos. Scripts are authored as `.mts` and compiled
  to `payload-dist/scripts/*.mjs`. The prose dirs (`skills/`, `agents/`, `rules/`,
  `output-styles/`, `kit-templates/`) are copied through verbatim. **`payload-dist/` is what
  ships and what `payloadPath()` reads.** Zero runtime dependencies, node builtins only, POSIX
  shells, enforced by `payload/__test__/dependencies.test.ts` (imports) and `payload/__test__/execution.test.ts`
  (actually executing each emitted script on bare node). Hook scripts must never crash: config
  via `loadConfigSafe()`, exit 0 on any failure path.
- Tests live in a `__test__/` **beside the code they are about**, per `payload/rules/testing.md`
  which this repo dogfoods. The split is by SUBJECT, not by unit-versus-e2e: a fixture-driven
  CLI test is still a test of its one subject, so `src/commands/__test__/modules.test.ts` holds
  both the pure `parseRequested` cases and the ones that drive the command against a real tree.
  Never add a `.e2e.test.ts` tier. If a file gets unwieldy, split it by CONCERN.
  - **The filename names the unit, and every `describe` in it is about that unit.** A file named
    for a theme is a grouping, and a grouping hides which unit is covered. `src/**/__test__/`,
    `src/modules/__test__/` (named for the module it covers), `payload/scripts/__test__/`,
    `payload/scripts/lib/__test__/`, and `payload/__test__/` for the two invariants over the
    whole built tree (`dependencies`, `execution`).
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

- `pnpm build`: `tsc` → `dist/`, regenerate the JSON Schema, then `publint`. Required before
  any `dist/` probe.
- `pnpm check`: `tsc --noEmit` over `src/` + `test/` + colocated `__test__/` dirs.
- `pnpm test`: full suite, including end-to-end init/update/doctor on fixtures.
- `node dist/cli.js init --yes --dry-run <repo>`: safe manual probe against any repo.
- `pnpm change`: record a changeset. Required for any user-visible change, and dogfooded.
- `pnpm dogfood`: build the payload, then symlink the kit into `.claude/` (gitignored) so this
  repo runs its own hooks/skills/agents. Idempotent, so re-run after pulling.
  **`.claude/scripts` points at `payload-dist/`, so a `.mts` edit is NOT live until it is
  compiled.** Run `pnpm dogfood:watch` (a `tsc --watch` on the payload) while working on hook
  scripts, or re-run `pnpm dogfood`. The prose dirs still link to `payload/` and are live.

## Rules

- The plan/apply boundary is load-bearing: modules return actions, only `src/apply.ts`
  writes (through `src/core/fs-target.ts`), and dry-run renders the same computed effects. Never
  add filesystem writes elsewhere.
- Kit-owned vs user-owned: copies and writes are manifest-tracked and update-refreshable. Seeds
  (kit.config.json, CLAUDE.md, reviewer drafts, .changeset/config.json) belong to the user, so
  never overwrite them.
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
  owns (CLAUDE.md today). It writes ONLY between the markers, and bytes outside them are
  never modified. Those paths are in `SHARED_HOST_FILES`: never created wholesale, never
  pruned, and their manifest hash covers the region BODY, not the file.
- Prose the kit ships (payload skills, agents, rules, templates, and the CLAUDE.md region
  `src/render.ts` generates) follows `payload/rules/prose-voice.md`: plain sentences, no
  semicolons, no em dash where a period or comma works. Frontmatter `description:` fields are
  the skill-routing signal, so keep every trigger term when rewording one.
- `src/types.ts` and `src/modules/shared.ts` predate the catch-all-files rule in
  `payload/rules/code-cleanliness.md`, which forbids both names. Tracked as KIT-1d28be. Do not
  start that rename as a side quest, and do not add new files of that shape.
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
