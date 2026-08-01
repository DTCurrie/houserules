# claude-kit

npm-published interactive installer (`npx claude-kit init`) for a portable Claude Code
context-discipline kit. Read README.md for the product story; this file is for working on
the kit itself.

## Layout

- `src/`: the installer, TypeScript — detect → plan (declarative actions) → preview → apply.
  May use npm dependencies (@clack/prompts, picocolors, zod). Builds to `dist/` (gitignored);
  `src/types.ts` is the shared model every module and command is typed against, and
  `src/core/config.ts` is the zod schema for `kit.config.json`.
- `schema/kit.config.schema.json` is **generated** from that zod schema by `pnpm run schema`.
  Never hand-edit it; `test/config-schema.test.ts` fails when it falls out of sync.
- `payload/`: everything copied into user repos. Scripts are authored as `.mts` and compiled
  to `payload-dist/scripts/*.mjs`; the prose dirs (`skills/`, `agents/`, `rules/`,
  `output-styles/`, `kit-templates/`) are copied through verbatim. **`payload-dist/` is what
  ships and what `payloadPath()` reads.** Zero runtime dependencies, node builtins only,
  POSIX shells — enforced by `test/payload-deps.test.ts` (imports) and
  `test/payload-run.test.ts` (actually executing each emitted script on bare node). Hook
  scripts must never crash: config via `loadConfigSafe()`, exit 0 on any failure path.
- `test/`: vitest suites + `fixtures.ts` generators (pnpm-monorepo / npm-single /
  non-js), all in mkdtemp dirs.

## Commands

- `pnpm build` — `tsc` → `dist/`, regenerate the JSON Schema, then `publint`. Required before
  any `dist/` probe.
- `pnpm check` — `tsc --noEmit` over `src/` + `test/`.
- `pnpm test` — full suite (includes end-to-end init/update/doctor on fixtures).
- `node dist/cli.js init --yes --dry-run <repo>` — safe manual probe against any repo.
- `pnpm change` — record a changeset (required for any user-visible change; dogfood).
- `pnpm dogfood` — build the payload, then symlink the kit into `.claude/` (gitignored) so this
  repo runs its own hooks/skills/agents. Idempotent; re-run after pulling.
  **`.claude/scripts` points at `payload-dist/`, so a `.mts` edit is NOT live until it is
  compiled** — run `pnpm dogfood:watch` (a `tsc --watch` on the payload) while working on hook
  scripts, or re-run `pnpm dogfood`. The prose dirs still link to `payload/` and are live.

## Rules

- The plan/apply boundary is load-bearing: modules return actions, only `src/apply.ts`
  writes (through `src/core/fs-target.ts`), dry-run renders the same computed effects. Never
  add filesystem writes elsewhere.
- Kit-owned vs user-owned: copies/writes are manifest-tracked and update-refreshable; seeds
  (kit.config.json, CLAUDE.md, reviewer drafts, .changeset/config.json) belong to the user —
  never overwrite.
- Two readers of kit.config.json, one shape: the CLI validates strictly via zod
  (`src/core/config.ts`); the payload reads it defensively and **dependency-free**
  (`loadConfigSafe()`). They share only the inferred `KitConfig` type — never make the payload
  import zod. `test/payload-deps.test.ts` enforces this.
- init never runs package-manager installs and never touches settings.local.json.
- Managed regions: the kit maintains its own marker-delimited block inside files the user
  owns (CLAUDE.md today). It writes ONLY between the markers — bytes outside them are
  never modified. Those paths are in `SHARED_HOST_FILES`: never created wholesale, never
  pruned, and their manifest hash covers the region BODY, not the file.
- The user always handles `git commit` / `push` / PR-create.

## Cost & verification discipline

- Stage-sized work (≤ a handful of files): implement directly in-context — no implementation
  subagents. Reserve subagents for genuinely parallel or unbounded work (wide sweeps, migrations).
- Exception — a planned phase under `/orchestrate`: dispatch one scoped `task-worker` per slice and
  review the returned reports; never pull a worker's diff into the main context.
- Verify with static gates (`pnpm test`, lint) plus a short falsifiable acceptance checklist for
  the user; no browser/screenshot verification unless explicitly asked.
- On AskUserQuestion timeout, stop and re-ask when the user returns — never carry tentative
  selections forward.
- Read this file + targeted greps before fanning out Explore/Plan agents.

## Release

changesets: merge to main → release workflow opens/updates a "Version Packages" PR →
merging that publishes to npm (`NPM_TOKEN` secret required). Never hand-edit CHANGELOG.md.
