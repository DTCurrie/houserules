# claude-kit

A portable kit of Claude Code infrastructure that keeps the agent's context lean. One command
installs it into any repo:

```
npx claude-kit init
```

(Unpublished or local checkout: `npx /path/to/claude-kit init`. Non-interactive: add `--yes`.
Preview only: add `--dry-run`.)

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
`<!-- claude-kit:claude-md start -->` and `<!-- claude-kit:claude-md end -->`. It rewrites
only what is inside those markers. Every byte outside them is yours and is never modified.
Opt out with `"claudeMd": { "managed": false }` in `.claude/kit.config.json` and the kit will
not touch the file at all.

## Modules

| Module             | Default                           | What you get                                                                                                                                                                                                                                                                                                                        |
| ------------------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core`             | always                            | shared libs, config-driven Bash guard (blocks `git commit/push/stash`, `gh pr create`), `kit.config.json`, read-only git permissions, CLAUDE.md seed (filled from detection) or staged additions                                                                                                                                    |
| `lint-fix`         | on when fix scripts found         | Stop hook: auto-fix changed packages, surface only unfixable residue (SubagentStop is wired but no-ops unless `fix.onSubagentStop`, since parallel subagents would each fix every package at once)                                                                                                                                  |
| `backlog`          | on                                | append-only backlog ledger + `/backlog-add` skill + `backlog-reviewer` agent (haiku)                                                                                                                                                                                                                                                |
| `changesets`       | on when `.changeset/` or monorepo | see below                                                                                                                                                                                                                                                                                                                           |
| `session-context`  | on                                | SessionStart hook: 3-line branch/changes/targets header                                                                                                                                                                                                                                                                             |
| `rename`           | on when TypeScript                | semantic TS rename via the LanguageService                                                                                                                                                                                                                                                                                          |
| `reviewers`        | off                               | per-target read-only reviewer agent **drafts** (marked DRAFT until you fill the authoritative source)                                                                                                                                                                                                                               |
| `ledger`           | off                               | per-commit JSONL ledger in `.claude/changelogs/` (in _addition_ to changesets) + archivist template                                                                                                                                                                                                                                 |
| `terse-style`      | off                               | token-lean output style (caveman-derived, MIT-attributed). Activate via `/config`                                                                                                                                                                                                                                                   |
| `debug-session`    | off                               | `/debug-session` skill: hypothesis→tagged-trace→cleanup loop (logs under `.claude/debug/`, verdicts via jq, all instrumentation removed) + SessionStart backstop + debugger agent template                                                                                                                                          |
| `plans`            | off                               | `/plan-project` skill: persist large/multi-phase work to a gitignored `.claude/plans/<name>/` (PLAN + living ROADMAP + per-phase sub-plans). Resume by grepping ROADMAP status                                                                                                                                                      |
| `orchestrate`      | off                               | `/orchestrate` skill + `task-worker` agent (sonnet): drive a planned phase by slicing it on **file ownership**, writing the shared seam first, then dispatching one worker per slice in waves. You review reports, never diffs (pairs with `plans`)                                                                                 |
| `code-comments`    | off                               | `.claude/rules/code-comments.md`: TSDoc for exported API, `//` for the rest, no file headers or landmark dividers, comment only for divergence-from-convention or non-obvious domain logic, 200-char cap. Path-scoped (`paths:` frontmatter), so it loads only when a matching source file is in play                               |
| `code-cleanliness` | off                               | `.claude/rules/code-cleanliness.md`: intention-revealing names, functions under 20-30 lines, no magic values, no dead code. Path-scoped, plus `.claude/reference/design-principles.md` (SOLID, DRY, KISS, YAGNI, rule of three), pull-only and never auto-loaded, and the `/tidy` skill that audits a working diff against the rule |
| `prose-voice`      | off                               | `.claude/rules/prose-voice.md`: plain sentences, no semicolons, em dashes rewritten away, filler cut, exact content byte-preserved. Path-scoped to markdown, so it loads when the agent is writing a changeset, plan, or doc                                                                                                        |
| `verify-changed`   | off                               | `/verify-changed` skill + script: run check/test/lint on the changed packages **and their transitive dependents**, inside a subagent. Only the PASS/FAIL-per-package verdict reaches the main context                                                                                                                               |
| `ready`            | off                               | `/ready` skill: off-context pre-handoff roll-up giving one ready/not-ready verdict plus the falsifiable acceptance checklist (pairs with `verify-changed` + `reviewers`)                                                                                                                                                            |
| `sweep`            | off                               | `/sweep` skill: shard a repo-wide mechanical edit into per-package writer subagents that report only counts. The orchestrator pays O(shards) and never sees the match set                                                                                                                                                           |
| `read-guard`       | off                               | PreToolUse(Read) guard: redirects unbounded whole-file reads of lockfiles/`dist`/`*.min.*`/oversized files toward grep or a windowed read (reads with `offset`/`limit` pass untouched)                                                                                                                                              |
| `regen`            | off                               | PostToolUse(Edit\|Write) hook: re-run a user-owned generator when an edited file matches a target's `regen { sourceGlob, command }`, so a generated reference snapshot never silently stales                                                                                                                                        |
| `statusline`       | off                               | kit-aware `statusLine`: pending changeset debt + kit targets touched (wired only if you have no statusline of your own)                                                                                                                                                                                                             |
| `persona-auditor`  | off                               | reference template for a read-only haiku auditor that **blind-ranks** a component's options from a persona's priorities before reconciling against what the system chose                                                                                                                                                            |

## Changesets are the canonical changelog

The kit treats [changesets](https://github.com/changesets/changesets) as the source of truth
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

## Token/compression options

- **Kit-native discipline** (free, always): lean CLAUDE.md, grep-don't-read rules, haiku/low
  subagents, hooks that emit residue not transcripts.
- **`terse-style`** (opt-in): ~50–70% fewer response tokens via terse phrasing, at a
  readability cost. Adapted from [caveman](https://github.com/JuliusBrussee/caveman) (MIT).
  Activate with `/config` → Output style → **Kit Terse**, or set `"outputStyle": "Kit Terse"`
  in `.claude/settings.local.json`. The value is the exact style name, **not** the `kit-terse`
  filename. A slug there silently falls back to Default with no error.
- **`prose-voice`** (opt-in): a path-scoped rule that holds agent-authored markdown to plain
  sentences, no semicolons, and no em dash where a period works. It shapes changesets, plans,
  and docs rather than chat responses, so it composes with any output style.

## After install

```
npx claude-kit doctor    # validate: config vs repo reality, hooks wired, files intact
                         # --json for a machine-readable report (CI-stable shape)
npx claude-kit update    # refresh kit files after a new kit release (your edits are kept, --force overrides)
                         # add --next-steps to reprint the post-install to-do list
npx claude-kit modules   # list installed vs available modules, and enable more after init
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
[kit] changeset-check.mjs missing — run: npx claude-kit update
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
npx claude-kit doctor --fix            # reconcile stale/missing/no-marker, your edits survive
npx claude-kit doctor --fix --force    # also overwrite the files you edited
npx claude-kit doctor --fix --prune    # also delete orphans
```

### `kit.config.json` is schema-validated

The config is validated against a schema generated from the kit's own zod definition and
published at `claude-kit/schema/kit.config.schema.json`. `init` seeds a `$schema` reference
into the file it writes, so editors give you completion and inline errors. `doctor` reports
any problem per field (`changesets.baseBranchh is not a known changesets setting`) and exits 2.

Smoke test the ledger + session detection:

```
node .claude/scripts/backlog-log.mjs add TEST /tmp/kit-smoke-BACKLOG.md "smoke" "remove me"
node .claude/scripts/backlog-log.mjs list /tmp/kit-smoke-BACKLOG.md
```

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
pnpm check                                 # tsc --noEmit over src/ + test/
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
