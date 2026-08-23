# packages/cli (@houserules/cli)

Working on the installer package. Repo-wide conventions stay in the root `CLAUDE.md`,
payload authoring in `docs/payload.md`, check wiring in `docs/package-checks.md`. Paths here
are relative to `packages/cli/`.

## Package

- `@houserules/cli` ships the binary **`houserules`**, so the package name and the command
  differ, the same split `@changesets/cli` uses for `changeset`. Install is
  `pnpm add -D @houserules/cli`, then `houserules <cmd>`. Its core ships 16 built-in modules
  (`src/plan.ts`'s `MODULES` array): `core`, `lint-fix`, `session-context`, `rename`,
  `reviewers`, `debug-session`, `plans`, `orchestrate`, `verify-changed`, `ready`, `sweep`,
  `read-guard`, `regen`, `statusline`, `code-cleanliness`, `ci-settings`.
- Six plugins hold modules that moved out of the core: `plugin-prose`, `plugin-testing`,
  `plugin-changesets`, `plugin-backlog`, `plugin-decisions`, `plugin-persona-auditor`. Six
  were authored as plugins and were never in the core: `plugin-accessibility`,
  `plugin-typescript`, `plugin-three`, `plugin-svelte`, `plugin-design`, `plugin-github`.
  `src/retired-modules.ts`'s `RETIRED_MODULES` maps every retired built-in id to the package
  that now ships it.
- **`.claude/` stays at the workspace root**, because that is where Claude Code looks, while
  each package's payload lives with that package. `scripts/dogfood-link.mjs` bridges the two
  by seeding this repo's `houserules.config.json`/`settings.json` and running the real
  installer over it, then relinking installed prose back to its payload source.

## Layout

- `src/`: the installer, in TypeScript. The pipeline is detect → plan (declarative actions) →
  preview → apply. May use npm dependencies (@clack/prompts, picocolors, zod). Builds to
  `dist/` (gitignored). Shared types that cross the plugin boundary live in the
  `@houserules/api` contract package, not scattered across `src/`. The map of which type
  lives where is in `packages/api/CLAUDE.md`. What stays local to `src/`:
  `Effect`/`PlanResult`/`PruneResult` in `src/plan.ts`, `Apply*` in `src/apply.ts`, and
  `Flags`/`EXIT` in `src/cli-contract.ts`.
- `schema/houserules.config.schema.json` is **generated** from the zod schema in
  `packages/api/src/config.ts` by `pnpm run schema`. Never hand-edit it.
  `src/core/__tests__/config.test.ts` fails when it falls out of sync.
- `payload/`: everything copied into user repos. Scripts are authored as `.mts` and compiled
  to `payload-dist/scripts/*.mjs`. The prose dirs (`skills/`, `agents/`, `rules/`,
  `templates/`) are copied through verbatim. `output-styles/` moved to `plugin-prose` along
  with the `output-prose` module, so it is no longer one of this package's prose dirs.
  **`payload-dist/` is what ships and what `payloadPath()` reads.** Zero runtime
  dependencies, node builtins only, POSIX shells, enforced by
  `payload/__tests__/dependencies.test.ts` (imports) and `payload/__tests__/execution.test.ts`
  (actually executing each emitted script on bare node). Hook scripts must never crash:
  config via `loadConfigSafe()`, exit 0 on any failure path.

## Dogfooding

- `pnpm dogfood`: build the payload, then wire this repo to run houserules on itself by
  running the real installer over itself. `scripts/dogfood-link.mjs` seeds
  `.claude/houserules.config.json` and `.claude/settings.json` (rewritten every run, since
  its `plugins` list and the module set the script passes to `init` are two halves of one
  definition), then shells out to `node dist/cli.js init --yes` with an explicit `--modules`
  list and `--module-option` flags, the same plan/apply pipeline a user's `init` runs. A
  relink pass runs after: any manifest-tracked destination under `skills/`, `agents/`,
  `output-styles/`, `rules/`, or `reference/` whose installed bytes are an exact, unique
  match for one payload source gets swapped back to a symlink at that source, so editing a
  payload rule or skill shows up in `.claude/` immediately, with no rebuild and no re-run of
  this script. Idempotent, so re-run after pulling.
  **`.claude/scripts/` stays a COPY taken from `payload-dist/`, never relinked** (a symlinked
  script cannot resolve `./lib/` from the symlink's real path), so a `.mts` edit has to be
  compiled AND re-copied before it is live. The two `appendBody` rules also stay real files,
  since their installed bytes carry a routing tail no payload source has byte-for-byte.
- `pnpm dogfood:watch`: `WIREIT_WATCH=true` over the `dogfood` graph, so editing or adding a
  payload `.mts` recompiles it and re-copies it into `.claude/scripts/` with no second
  command. It covers every package that ships payload scripts, not just the CLI. This
  replaced a bare `tsc --watch` on the payload, which compiled to `payload-dist/` and
  stopped, leaving the copy under `.claude/scripts/` stale. Anyone following the old
  instructions was editing a hook and testing the previous version of it.
  **DELETING a script is still not covered. Re-run `pnpm dogfood`.** The watcher does fire,
  but that run treats `build:payload` as fresh and does not re-restore its output, so the
  orphaned `.mjs` survives in both `payload-dist/` and `.claude/scripts/` until a new wireit
  process runs. Verified, not assumed. Outside the watch a deletion is handled correctly,
  because wireit restores the cached output for the reverted fingerprint.

## Rules

- The plan/apply boundary is load-bearing: modules return actions, only `src/apply.ts`
  writes (through `src/core/fs-target.ts`), and dry-run renders the same computed effects.
  Never add filesystem writes elsewhere.
- Kit-owned vs user-owned: copies and writes are manifest-tracked and update-refreshable.
  Seeds (houserules.config.json, CLAUDE.md, reviewer drafts, .changeset/config.json) belong
  to the user, so never overwrite them.
- Ownership can split INSIDE one file, and there are two shapes of that. A `region` action
  means houserules owns a marker-delimited block in a file the user owns. A `body` action is
  the mirror: houserules owns everything below the closing `---` and the user owns the
  frontmatter above it. Rules are the `body` case, because houserules' own advise text tells
  users to trim a rule's `paths:` to their repo. Both record a hash of the part the KIT
  wrote, never of the whole file, and `update` splices rather than overwrites. Adding a
  third split needs a reason this good.
- `.claude/scripts/` is **generated, not source**: self-gitignored on init, and installs
  that committed it are migrated by `update` (`git rm --cached` only, working tree
  untouched, never committed). `scripts.commit: true` opts back into committing them.
  Because the scripts may be absent on a fresh clone while `settings.json` is committed,
  `hookCommand()` wraps every hook in a file-existence guard that `exec`s node. `exec` is
  load-bearing, since a plain `node` would let any non-zero exit fall through to the
  fallback echo and swallow the code (changeset-check exits 2 on purpose).
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
- `doctor` is an orchestrator over independent checks. Each check in `src/commands/doctor/`
  is a pure-ish function of `(root, ctx, flags)` returning `{ findings, readouts }`, and
  `src/commands/doctor.ts` only sequences them and rolls the severity up to an exit code.
  Order matters in two places. `checkConfigValidity` runs first and is a gate: a config the
  schema rejects means every later check would read fields it cannot trust, and `--fix`
  would plan writes from it, so `doctor()` reports the schema problems and returns exit 2
  without running anything else. `reconcileDrift` runs last because `--fix` writes, and
  every check before it must see the tree as the user left it. Add a new check as a new
  file, never as another branch inside `doctor()`.
- `src/retired-modules.ts`'s `RETIRED_MODULES` entries are permanent. Removing one re-arms a
  silent prune for any repo that upgrades the CLI without also installing the plugin the
  module moved to: `computePrune` deletes any manifest dest the current plan no longer
  produces, and a removed entry stops that from erroring first.
- Any guard that prevents a prune must run before `computeEffects` and inside the command's
  `HouseError` handler. `assertNoRetiredModules` is that guard: it has to see the recorded
  module set before a plan is computed from it, and it throws `HouseError` so the command
  aborts with nothing written rather than silently deleting the retired module's files.
- Changes to generated prose (`src/render.ts`) need a rendered probe, not just a green
  suite. Run `init` against a fixture and read the output. Static tests do not catch a
  dropped sentence boundary.
