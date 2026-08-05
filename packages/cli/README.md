# agent-kit

A portable kit of Claude Code infrastructure that keeps the agent's context lean. Install it
and run `init` in any repo:

```
pnpm add -D @agent-kit/cli
pnpm exec agent-kit init
```

The package is `@agent-kit/cli` and the binary it installs is `agent-kit`, the same split
`@changesets/cli` uses for `changeset`. Every later command is just `agent-kit <cmd>`, since
the local binary is on the path once the package is a dependency.

(Local checkout: `node /path/to/agent-kit/packages/cli/dist/cli.js init`. Non-interactive:
add `--yes`. Preview only: add `--dry-run`.)

## The one idea

**Context out, not context in.** Every piece pushes work _off_ the main agent's context
window: into disposable subagents, onto disk (ledgers, changesets), into deterministic
scripts, or behind grep-able snapshots. The main thread holds verdicts and pointers, not the
reading that produced them. Four levers:

- **Resident context** (paid every turn): a lean CLAUDE.md, nested per-package guidance,
  "grep don't read whole" rules.
- **Re-derivation** (paying twice for one conclusion): guardrail docs, backlog ledger,
  changesets, memory conventions.
- **Round-trips** (permission stalls, re-orientation): permission allowlist, hooks, the
  session-start header.
- **Cost-not-count** (same tokens, cheaper rate): `model: haiku` and `effort: low` subagents,
  plus opt-in output compression.

## What `init` does

1. **Detects** the repo read-only: package manager, workspace packages, per-package fix
   scripts (it knows `fix` vs `lint:fix`+`format:fix` divergence), TypeScript, changesets
   state, and existing `.claude/` files. Then it shows you the profile it concluded.
2. **Asks** which modules you want (multiselect, preselected from detection) and which
   targets to track.
3. **Previews** the full plan: every file it would create, the exact `settings.json` diff,
   and what it skips because it's yours. Only then does it write.
4. **Records** a receipt (`.claude/kit-manifest.json`, file hashes) so `update` can refresh
   kit files without clobbering your edits, and `doctor` can tell drift from damage.

Non-destructive guarantees: it never runs package-manager installs, never touches
`settings.local.json`, never rewrites unparseable JSON, backs up `settings.json` once before
its first merge, and `--dry-run` writes nothing at all.

In your `CLAUDE.md` the kit maintains a **marked block**, everything between
`<!-- agent-kit:claude-md start -->` and `<!-- agent-kit:claude-md end -->`. It rewrites
only what is inside those markers. Every byte outside them is yours and is never modified.
Opt out with `"claudeMd": { "managed": false }` in `.claude/kit.config.json` and the kit will
not touch the file at all.

## Modules

`@agent-kit/cli` ships exactly 15 modules. Everything else lives in a plugin package.

| Module             | Default                   | What you get                                                                                                                                                                                                                                                                                                                        |
| ------------------ | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core`             | always                    | shared libs, config-driven Bash guard (blocks `git commit/push/stash`, `gh pr create`), `kit.config.json`, read-only git permissions, CLAUDE.md seed (filled from detection) or staged additions                                                                                                                                    |
| `lint-fix`         | on when fix scripts found | Stop hook: auto-fix changed packages, surface only unfixable residue (SubagentStop is wired but no-ops unless `fix.onSubagentStop`, since parallel subagents would each fix every package at once)                                                                                                                                  |
| `session-context`  | on                        | SessionStart hook: 3-line branch/changes/targets header                                                                                                                                                                                                                                                                             |
| `rename`           | on when TypeScript        | semantic TS rename via the LanguageService                                                                                                                                                                                                                                                                                          |
| `reviewers`        | off                       | per-target read-only reviewer agent **drafts** (marked DRAFT until you fill the authoritative source)                                                                                                                                                                                                                               |
| `debug-session`    | off                       | `/debug-session` skill: hypothesis→tagged-trace→cleanup loop (logs under `.claude/debug/`, verdicts via jq, all instrumentation removed) + SessionStart backstop + debugger agent template                                                                                                                                          |
| `plans`            | off                       | `/plan-project` skill: persist large/multi-phase work to a gitignored `.claude/plans/<name>/` (PLAN + living ROADMAP + per-phase sub-plans), then stop. Implementing a phase is a separate step. Resume by grepping ROADMAP status                                                                                                  |
| `orchestrate`      | off                       | `/orchestrate` skill + `task-worker` agent (sonnet): drive a planned phase by slicing it on **file ownership**, writing the shared seam first, then dispatching one worker per slice in waves. You review reports, never diffs (pairs with `plans`)                                                                                 |
| `verify-changed`   | off                       | `/verify-changed` skill + script: run check/test/lint on the changed packages **and their transitive dependents**, inside a subagent. Only the PASS/FAIL-per-package verdict reaches the main context                                                                                                                               |
| `ready`            | off                       | `/ready` skill: off-context pre-handoff roll-up giving one ready/not-ready verdict plus the falsifiable acceptance checklist (pairs with `verify-changed` + `reviewers`)                                                                                                                                                            |
| `sweep`            | off                       | `/sweep` skill: shard a repo-wide mechanical edit into per-package writer subagents that report only counts. The orchestrator pays O(shards) and never sees the match set                                                                                                                                                           |
| `read-guard`       | off                       | PreToolUse(Read) guard: redirects unbounded whole-file reads of lockfiles/`dist`/`*.min.*`/oversized files toward grep or a windowed read (reads with `offset`/`limit` pass untouched)                                                                                                                                              |
| `regen`            | off                       | PostToolUse(Edit\|Write) hook: re-run a user-owned generator when an edited file matches a target's `regen { sourceGlob, command }`, so a generated reference snapshot never silently stales                                                                                                                                        |
| `statusline`       | off                       | kit-aware `statusLine`: pending changeset debt + kit targets touched (wired only if you have no statusline of your own)                                                                                                                                                                                                             |
| `code-cleanliness` | off                       | `.claude/rules/code-cleanliness.md`: intention-revealing names, functions under 20-30 lines, no magic values, no dead code. Path-scoped, plus `.claude/reference/design-principles.md` (SOLID, DRY, KISS, YAGNI, rule of three), pull-only and never auto-loaded, and the `/tidy` skill that audits a working diff against the rule |

## Plugins

A plugin is a separate package that contributes more modules. Install it as a dependency
and declare it in `.claude/kit.config.json` (see [Writing a plugin](#writing-a-plugin)) to
select its modules.

| Package                             | Modules it ships                                                                                                                                                                                    |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@agent-kit/plugin-prose`           | ships `code-comments`, `prose-voice`, `output-prose`                                                                                                                                                |
| `@agent-kit/plugin-testing`         | ships `testing` (plus opt-in `testing-typescript` and `testing-javascript` language guides, chosen through the module's options)                                                                    |
| `@agent-kit/plugin-changesets`      | ships `changesets`, `ledger`                                                                                                                                                                        |
| `@agent-kit/plugin-backlog`         | ships `backlog`                                                                                                                                                                                     |
| `@agent-kit/plugin-decisions`       | ships `decisions`                                                                                                                                                                                   |
| `@agent-kit/plugin-persona-auditor` | ships `persona-auditor`                                                                                                                                                                             |
| `@agent-kit/plugin-accessibility`   | ships `accessibility` (WCAG rule, pull-only criteria reference, and the `wcag.mjs` router, plus opt-in React/Svelte/Vue/HTML guides chosen through the module's options) and `accessibility-review` |

Installing a plugin opts you into the plugin. Each module inside it still honors its own
default: most default off, so you enable them individually with `--modules` or through
`modules` in the interactive prompt.

## Upgrading from a pre-split version

A module now shipped by a plugin used to be built into the CLI. If your `.claude/kit.config.json`
or manifest still names one of those modules and the plugin isn't installed, `update` exits 1
without changing anything:

```
This install uses modules that moved out of the CLI into plugins:
  backlog moved to @agent-kit/plugin-backlog. Install it, then add
  { "name": "@agent-kit/plugin-backlog", "alias": "<alias>" } to the "plugins" array in .claude/kit.config.json.
Nothing was changed. Installing the plugin restores the module and its files.
```

The module's files on disk are never deleted by this error. Install the named package, add
the `plugins` entry the message shows, and re-run `update` to pick the module back up. The
recorded module ids are rewritten to their new namespaced form as part of that run, so this is
a one-time step and a second `update` is a no-op.

Three other things move in the same upgrade, and two of them need a command from you.

**Your `CLAUDE.md` block is adopted automatically.** A pre-rename install carries
`<!-- claude-kit:claude-md start -->`. `update` recognizes that pair, replaces it with the
current one, and leaves every byte outside the markers untouched. No second block is created,
and there is nothing to run.

**The ledgers move to `.claude/ledgers/`, on first use rather than during `update`.** A ledger
at `.claude/backlog.log` or `.claude/decisions.log` is renamed to
`.claude/ledgers/<name>.jsonl` the first time a ledger command runs, not by `update` itself. Run
any ledger command once to trigger it:

```
node .claude/scripts/backlog-log.mjs list
```

The rename is what makes the ledger committable. A `.log` extension is caught by the `*.log`
pattern most repos already have, so the record was invisible to git. Commit
`.claude/ledgers/` once it exists. The `.gitignore` written beside it keeps the generated
`*.md` out, because the `.jsonl` is the record and the markdown is a view of it.

**Rendered surfaces need one `render`.** Entries recorded before the move name their surface by
repo-relative path, such as `games/tower-push/BACKLOG.md`. Those are matched to the area they
belong to on read, so nothing is lost, but no markdown exists until you ask for it:

```
node .claude/scripts/backlog-log.mjs render
```

With no argument it writes every surface the ledger implies, including an area whose entries
have all been resolved.

A surface you committed at its old path is untracked for you, including a nested one such as
`games/tower-push/BACKLOG.md`. The file stays on disk and the removal is staged, never committed,
so you review it like any other change. Only a path the ledger itself records is offered, so a
`BACKLOG.md` you wrote by hand and the kit never generated is left alone.

## Changesets are the canonical changelog

Shipped by `@agent-kit/plugin-changesets`. The kit treats
[changesets](https://github.com/changesets/changesets) as the source of truth
for "what shipped": one `.changeset/*.md` per meaningful change, `CHANGELOG.md` generated at
release time by `changeset version`. The module wires the agent side of that:

- **`changeset-write.mjs`** is a non-interactive changeset author for agents. It validates
  package names against the _actual_ workspace, then writes via the repo's own
  `@changesets/write`, the same writer `changeset add` uses. The official library is
  **required**. If it isn't resolvable from the repo root, the script exits with install
  instructions instead of hand-rolling a file. Supports `--empty` for "no release needed".
  Agents never hand-write `.changeset/*.md`.
- **`/changeset` skill + `changeset-writer` agent (haiku)** inspect the diff, pick
  patch/minor/major (major always asks first), and record via the script.
- **`changeset-check.mjs`** (Stop hook) nudges once when package source changed with no
  changeset alongside it. It is branch-aware, so a changeset already committed on the branch
  counts. The kill-switch is `changesets.stopCheck: false` in `kit.config.json`, and it exits
  silently on any git hiccup.
- **Respects an existing setup.** If `.changeset/config.json` exists it is never touched. If
  absent, a default is seeded, only with your consent. The kit never installs
  `@changesets/cli` for you and prints the right command instead (pnpm-catalog-aware).
  Authoring does require it as a root devDependency: a `pnpx`/`npx`-only root script covers
  versioning and publishing but leaves nothing resolvable for `@changesets/write`.

Want commit-granular history _too_? Enable the `ledger` module. It writes to
`.claude/changelogs/<target>.md`, never the `CHANGELOG.md` changesets owns.

## Token spend and response style

Only the first of these three reduces token spend. The other two shape how the agent writes, which
is worth having and is not the same thing. `output-prose` and `prose-voice` are shipped by
`@agent-kit/plugin-prose`.

- **Kit-native discipline** (free, always): lean CLAUDE.md, grep-don't-read rules, haiku/low
  subagents, hooks that emit residue not transcripts.
- **`output-prose`** (opt-in): shorter, denser replies via terse phrasing, at a readability cost.
  Adapted from [caveman](https://github.com/JuliusBrussee/caveman) (MIT). **It is a readability
  setting, not a cost one.** It changes how the agent writes to you, not what it does, and it will
  not reduce your token bill: the words in a reply are a small part of what a session spends, and
  the style's own text is added to every request. Exact content, negations, and reported caveats
  are preserved. What to expect is in `@agent-kit/plugin-prose`'s README.
  Activate with `/config` → Output style → **Prose**, or
  set `"outputStyle": "Prose"` in `.claude/settings.local.json`. The value is the exact style
  name, **not** the `output-prose` filename. A slug there silently falls back to Default with
  no error. An output style is read once at session start, so a change takes effect after
  `/clear` or in the next session. It also applies to the main thread only, since a subagent
  runs its own system prompt.
- **`prose-voice`** (opt-in): a path-scoped rule that holds agent-authored prose to plain
  sentences, no semicolons, and no em dash where a period works. It shapes changesets, plans,
  docs, and the sentences inside code comments rather than chat responses, so it composes with
  any output style. It covers source files as well as markdown, which is what keeps one voice
  across the repo instead of two.

## After install

```
npx agent-kit doctor    # validate: config vs repo reality, hooks wired, files intact
                         # --json for a machine-readable report (CI-stable shape)
npx agent-kit update    # refresh kit files after a new kit release (your edits are kept, --force overrides)
                         # add --next-steps to reprint the post-install to-do list
npx agent-kit modules   # list installed vs available modules, and enable more after init
                         # --disable=<ids> withdraws a module: prunes its files (your edits
                         # are kept unless --force) and unwires only the settings entries no
                         # remaining module still needs
```

Every command takes the target repo as a positional `[dir]` or via `--cwd <dir>`, plus a
global `--dry-run`. Flags are scoped per subcommand, so a flag that doesn't apply is an
error rather than a silent no-op.

**Exit codes.** `doctor` is usable as a CI gate:

| Code | Meaning                                               |
| ---- | ----------------------------------------------------- |
| 0    | success (`doctor`: no problems)                       |
| 1    | error, or `doctor` found a problem / actionable drift |
| 2    | `.claude/kit.config.json` does not satisfy the schema |

### `.claude/scripts/` is generated, not source

The hook scripts are build output, so the kit self-gitignores them. `.claude/scripts/.gitignore`
and `.claude/state/.gitignore` are the only files there that git tracks. Your `settings.json`,
`kit.config.json`, skills, agents and rules are all still committed. Only the generated `.mjs`
stays out of your diffs, so a kit upgrade doesn't show up as a wall of machine-written churn.

If a repo already committed its scripts, `update` migrates it for you. The paths are
`git rm --cached`'d, which is **staged only**. Files stay on disk, and the kit never commits.
`doctor` reports the state until you do.

Because the scripts can be absent on a fresh clone while `settings.json` is committed, every hook
command is guarded. A missing script prints

```
[kit] changeset-check.mjs missing — run: npx agent-kit update
```

instead of a Node stack trace, and the hook exits cleanly rather than failing your turn.

Want the old behavior? Set `scripts.commit: true` in `.claude/kit.config.json`. The kit then
skips the gitignore and the migration entirely.

### Drift: `stale` vs `yours`

`doctor` reports every managed file whose contents no longer match what the kit would write,
with a unified diff, and says **why** they differ:

| Status      | Means                                                                    | Exit 1? |
| ----------- | ------------------------------------------------------------------------ | ------- |
| `stale`     | the kit changed, and your copy is what it last wrote                     | yes     |
| `missing`   | a kit file is gone (a hook now wired to nothing)                         | yes     |
| `no-marker` | a managed block's markers were removed                                   | yes     |
| `orphaned`  | no enabled module produces it any more                                   | yes     |
| `yours`     | **you** edited it, so it is kept and never overwritten without `--force` | no      |

That distinction is the point. A content-hash lockfile can only say "differs". The kit's
manifest records what it last wrote, so it can tell a kit-side change from one of yours. **An
edit you made on purpose never holds the exit code red.** Nothing lets you acknowledge one, so
failing on it would leave `doctor` permanently red on an install working exactly as you intended.

```
npx agent-kit doctor --fix            # reconcile stale/missing/no-marker, your edits survive
npx agent-kit doctor --fix --force    # also overwrite the files you edited
npx agent-kit doctor --fix --prune    # also delete orphans
```

### Rules: you own the frontmatter, the kit owns the body

A rule's `paths:` globs decide when Claude Code loads it, and only your repo knows which
suffixes it actually uses. So a rule file is split down the middle. Everything below the
closing `---` is the kit's and stays refreshable forever. The frontmatter above it is yours.

Trim `paths:` to your repo and nothing breaks. It is not drift, it is not a warning, and the
rule body still updates. The only time the kit says anything is when it ships a new default
`paths:` and yours differ, and then it tells you once and keeps your version.

### The formatter

Everything the kit installs under `.claude/` is tracked by content hash, so a repo-wide
`prettier --write .` rewrites those bytes and `update` then reads your whole install as local
edits and refuses to refresh it. Nothing warns you, because from the manifest's side it looks
exactly like you edited every file.

When prettier is detected, the kit maintains a marker-delimited block in `.prettierignore`
listing the subtrees it owns. Everything outside the markers is untouched, and a repo with no
prettier never gains the file. eslint flat config is JavaScript, so the kit prints the
`ignores` entry for you to paste instead of editing it.

Already hit this? `npx agent-kit doctor --fix --force` takes the kit's copies back.

### `kit.config.json` is schema-validated

The config is validated against a schema generated from the kit's own zod definition and
published inside `@agent-kit/cli` at `schema/kit.config.schema.json`. `init` seeds a `$schema`
reference into the file it writes, so editors give you completion and inline errors. A repo
that depends on `@agent-kit/cli` gets the local
`../node_modules/@agent-kit/cli/schema/kit.config.schema.json`. One that only ever runs
`npx agent-kit` has no local copy, so it gets the published URL instead. `doctor` reports
any problem per field (`changesets.baseBranchh is not a known changesets setting`) and exits 2.

## Ledgers: what is committed and what is generated

The backlog and decision modules keep an append-only ledger at
`.claude/ledgers/<name>.jsonl`. **That file is the record and it is committed.** The
`BACKLOG.md` and `DECISIONS.md` beside it are rendered from it and are gitignored, so a hand
edit does not survive the next write. Rebuild either any time:

```
node .claude/scripts/backlog-log.mjs render BACKLOG.md
```

A monorepo separates areas by filename in that one directory, `studio.BACKLOG.md`, rather than
by nesting a ledger beside each package. Point `ledgers.dir` in `.claude/kit.config.json`
somewhere else if you prefer, though it cannot be the repo root: the kit self-ignores that
directory with `*.md`, and that rule at the root would hide every document in the project.

Smoke test the backlog ledger, if `@agent-kit/plugin-backlog` is installed:

```
node .claude/scripts/backlog-log.mjs add TEST BACKLOG.md "smoke" "remove me"
node .claude/scripts/backlog-log.mjs list
```

## Writing a plugin

A plugin is a module provider. It contributes `ModuleDef`s, the same shape `core` and every
built-in module use, and nothing else: no lifecycle hooks, no way to transform another
module's actions, no path onto disk that isn't a declared action. The kit decides what those
actions mean against the real tree, so a plugin's plan shows up in `--dry-run` the same as a
built-in module's does. See the `PluginApi` and `Plugin` TSDoc in `src/plugin.ts` for the full
contract, including what happens when a plugin throws.

### Declaring one

A user installs your package as a dependency, then adds it to the `plugins` array in
`.claude/kit.config.json`:

```json
{
  "plugins": [{ "name": "@agent-kit/plugin-prose", "alias": "prose" }],
  "targets": []
}
```

`name` is an npm package name or a repo-relative path to a directory holding a
`package.json`. `alias` namespaces every module id your plugin contributes: a module
declaring id `prose-voice` under alias `prose` is selected as `prose/prose-voice`, in
`--modules` and in `moduleOptions` keys alike. An optional `config` object is passed to your
factory verbatim, through `PluginApi.config`, and the kit never reads inside it.

### Building it

Publish it as `@agent-kit/plugin-<name>`, with

```json
"peerDependencies": { "@agent-kit/cli": "^<major>" }
```

pinned to the major version of the `PluginApi` surface you built against. See
[CONVENTIONS.md](CONVENTIONS.md#11-plugin-surface-semver-policy) for what changes at each
bump.

The default export is a factory, wrapped in `definePlugin` for the parameter and return
types:

```ts
import { definePlugin } from '@agent-kit/cli/plugin';

export default definePlugin((api) => [
  {
    id: 'fixture-rule',
    title: 'Fixture Rule',
    group: 'optional',
    hint: () => 'installs a fixture rule',
    defaultEnabled: () => false,
    plan: () => [
      api.payload.rule('fixture-rule', 'fixture-rule', 'plugin fixture'),
    ],
  },
]);
```

`api.payload` is already bound to this plugin's own `payload-dist/`, so `plan()` never
resolves a path itself. Lay out `payload-dist/` the same way the kit lays out its own
payload, since that is what each `api.payload` builder expects: `scripts/` (plus
`scripts/lib/` for shared libraries), `rules/`, `skills/<name>/SKILL.md`, `agents/<name>.md`,
`reference/`, and `kit-templates/`. A plugin's payload scripts carry the same invariants the
kit's own do: zero npm dependencies, node builtins only, and a hook script that exits 0 on
every failure path rather than crashing a turn.

A payload script that needs shared logic imports it from `.claude/scripts/lib/*.mjs` rather
than vendoring a copy. That surface is a public runtime API, versioned with the CLI. See
[CONVENTIONS.md](CONVENTIONS.md#11-plugin-surface-semver-policy).

Your package builds its own `payload-dist/` from source, the same way `@agent-kit/cli`
builds its own. `PluginApi.payload` reads from your plugin's `payload-dist/`, never from the
CLI's, so ship one alongside your compiled `dist/`.

## Support matrix & port hazards

- **git required.** Every script resolves paths from `git rev-parse --show-toplevel`.
- **Package managers.** pnpm and npm are first-class, yarn-classic workspaces are best-effort,
  and npm-monorepo per-package filtering is not modeled (set `fix.filterFlag: ""` and use a root
  fix script). Workspace globs support the common shapes (`packages/*`). Exotic globs won't
  detect, so edit `kit.config.json` by hand. That file, not detection, is the contract.
- **POSIX shells only** (hooks use `"$CLAUDE_PROJECT_DIR"`). Windows via WSL/git-bash untested.
- **`rename.mjs` is TypeScript-only** and needs `typescript` resolvable.
- **The lint-fix hook assumes your fix scripts exist.** Doctor checks this.
- **Subagent discipline is load-bearing.** Reviewers keep `tools: Read, Grep, Glob` and their
  tool-call budgets, or the savings evaporate.
- **Don't auto-load big docs.** Guardrail docs are read on a trigger, never `@-imported`.
  See [CONVENTIONS.md](CONVENTIONS.md).

## Developing the kit itself

```
pnpm install
pnpm build                                 # tsc -> dist/, then publint
pnpm dogfood                               # link the kit into .claude/ (gitignored) so this repo runs its own kit
pnpm test                                  # vitest suite incl. end-to-end init on fixtures
pnpm check                                 # tsc --noEmit over src/ + test/ + colocated __test__/
node dist/cli.js init --dry-run --yes <some-repo>
pnpm change                                # record a changeset for your change (dogfood)
```

`src/` is TypeScript and may use dependencies. **Everything under `payload/` is copied into user
repos and must stay zero-dependency node builtins.** Hook scripts are authored as `.mts` and
compiled to plain `.mjs` in `payload-dist/`, which is what ships. Two tests enforce that promise:
one parses every emitted script's imports, the other actually executes each one on bare node with
no `node_modules` in reach. Editing a `.mts` needs a rebuild before the dogfooded hooks pick it
up, and `pnpm dogfood:watch` covers that.

Releases: changesets → the release workflow opens a "Version Packages" PR → merging it publishes
to npm (needs an `NPM_TOKEN` repo secret).
