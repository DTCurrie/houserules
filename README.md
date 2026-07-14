# claude-kit

A portable kit of Claude Code infrastructure that keeps the agent's context lean — installed
into any repo by one command:

```
npx claude-kit init
```

(Unpublished / local checkout: `npx /path/to/claude-kit init`. Non-interactive: add `--yes`;
preview only: add `--dry-run`.)

## The one idea

**Context out, not context in.** Every piece pushes work _off_ the main agent's context
window — into disposable subagents, onto disk (ledgers, changesets), into deterministic
scripts, or behind grep-able snapshots. The main thread holds verdicts and pointers, not the
reading that produced them. Four levers:

- **Resident context** (paid every turn): a lean CLAUDE.md, nested per-package guidance,
  "grep don't read whole" rules.
- **Re-derivation** (paying twice for one conclusion): guardrail docs, backlog ledger,
  changesets, memory conventions.
- **Round-trips** (permission stalls, re-orientation): permission allowlist, hooks, the
  session-start header.
- **Cost-not-count** (same tokens, cheaper rate): `model: haiku` + `effort: low` subagents;
  opt-in output compression.

## What `init` does

1. **Detects** the repo read-only: package manager, workspace packages, per-package fix
   scripts (it knows `fix` vs `lint:fix`+`format:fix` divergence), TypeScript, changesets
   state, existing `.claude/` files — and shows you the profile it concluded.
2. **Asks** which modules you want (multiselect, preselected from detection) and which
   targets to track.
3. **Previews** the full plan — every file it would create, the exact `settings.json` diff,
   what it skips because it's yours — and only then writes.
4. **Records** a receipt (`.claude/kit-manifest.json`, file hashes) so `update` can refresh
   kit files without clobbering your edits, and `doctor` can tell drift from damage.

Non-destructive guarantees: it never runs package-manager installs, never edits an existing
`CLAUDE.md`, never touches `settings.local.json`, never rewrites unparseable JSON, backs up
`settings.json` once before its first merge, and `--dry-run` writes nothing at all.

## Modules

| Module            | Default                           | What you get                                                                                                                                                                                     |
| ----------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `core`            | always                            | shared libs, config-driven Bash guard (blocks `git commit/push/stash`, `gh pr create`), `kit.config.json`, read-only git permissions, CLAUDE.md seed (filled from detection) or staged additions |
| `lint-fix`        | on when fix scripts found         | Stop/SubagentStop hook: auto-fix changed packages, surface only unfixable residue                                                                                                                |
| `backlog`         | on                                | append-only backlog ledger + `/backlog-add` skill + `backlog-reviewer` agent (haiku)                                                                                                             |
| `changesets`      | on when `.changeset/` or monorepo | see below                                                                                                                                                                                        |
| `session-context` | on                                | SessionStart hook: 3-line branch/changes/targets header                                                                                                                                          |
| `rename`          | on when TypeScript                | semantic TS rename via the LanguageService                                                                                                                                                       |
| `reviewers`       | off                               | per-target read-only reviewer agent **drafts** (marked DRAFT until you fill the authoritative source)                                                                                            |
| `ledger`          | off                               | per-commit JSONL ledger in `.claude/changelogs/` (in _addition_ to changesets) + archivist template                                                                                              |
| `terse-style`     | off                               | token-lean output style (caveman-derived, MIT-attributed); activate via `/config`                                                                                                                |
| `debug-session`   | off                               | `/debug-session` skill: hypothesis→tagged-trace→cleanup loop (logs under `.claude/debug/`, verdicts via jq, all instrumentation removed) + SessionStart backstop + debugger agent template       |
| `plans`           | off                               | `/plan` skill: persist large/multi-phase work to a gitignored `.claude/plans/<name>/` (PLAN + living ROADMAP + per-phase sub-plans); resume by grepping ROADMAP status                           |

## Changesets are the canonical changelog

The kit treats [changesets](https://github.com/changesets/changesets) as the source of truth
for "what shipped": one `.changeset/*.md` per meaningful change, `CHANGELOG.md` generated at
release time by `changeset version`. The module wires the agent side of that:

- **`changeset-write.mjs`** — non-interactive changeset author for agents: validates
  package names against the _actual_ workspace, then writes via the repo's own
  `@changesets/write` (the same writer `changeset add` uses). The official library is
  **required** — if it isn't resolvable from the repo root, the script exits with install
  instructions instead of hand-rolling a file. Supports `--empty` for "no release needed".
  Agents never hand-write `.changeset/*.md`.
- **`/changeset` skill + `changeset-writer` agent (haiku)** — inspect the diff, pick
  patch/minor/major (major always asks first), record via the script.
- **`changeset-check.mjs`** (Stop hook) — nudges once when package source changed with no
  changeset alongside it. Branch-aware (a changeset already committed on the branch counts),
  kill-switch in `kit.config.json` (`changesets.stopCheck: false`), exits silently on any git
  hiccup.
- **Respects an existing setup**: if `.changeset/config.json` exists it is never touched; if
  absent, a default is seeded (only with your consent). The kit never installs
  `@changesets/cli` for you — it prints the right command instead (pnpm-catalog-aware).
  Authoring does require it as a root devDependency: a `pnpx`/`npx`-only root script covers
  versioning/publishing but leaves nothing resolvable for `@changesets/write`.

Want commit-granular history _too_? Enable the `ledger` module — it writes to
`.claude/changelogs/<target>.md`, never the `CHANGELOG.md` changesets owns.

## Token/compression options

- **Kit-native discipline** (free, always): lean CLAUDE.md, grep-don't-read rules, haiku/low
  subagents, hooks that emit residue not transcripts.
- **`terse-style`** (opt-in): ~50–70% fewer response tokens via terse phrasing, at a
  readability cost. Adapted from [caveman](https://github.com/JuliusBrussee/caveman) (MIT).
  Activate with `/config` → Output style → **Kit Terse**, or set `"outputStyle": "Kit Terse"`
  in `.claude/settings.local.json`. The value is the exact style name, **not** the `kit-terse`
  filename — a slug there silently falls back to Default with no error.

## After install

```
npx claude-kit doctor    # validate: config vs repo reality, hooks wired, files intact
npx claude-kit update    # refresh kit files after a new kit release (your edits are kept; --force overrides)
npx claude-kit modules   # list installed vs available modules; enable more after init (add-only)
```

Smoke test the ledger + session detection:

```
node .claude/scripts/backlog-log.mjs add TEST /tmp/kit-smoke-BACKLOG.md "smoke" "remove me"
node .claude/scripts/backlog-log.mjs list /tmp/kit-smoke-BACKLOG.md
```

## Support matrix & port hazards

- **git required** — every script resolves paths from `git rev-parse --show-toplevel`.
- **Package managers**: pnpm and npm first-class; yarn-classic workspaces best-effort;
  npm-monorepo per-package filtering is not modeled (set `fix.filterFlag: ""` and use a root
  fix script). Workspace globs support the common shapes (`packages/*`); exotic globs won't
  detect (edit `kit.config.json` by hand — it, not detection, is the contract).
- **POSIX shells only** (hooks use `"$CLAUDE_PROJECT_DIR"`); Windows via WSL/git-bash untested.
- **`rename.mjs` is TypeScript-only** and needs `typescript` resolvable.
- **The lint-fix hook assumes your fix scripts exist** — doctor checks this.
- **Subagent discipline is load-bearing**: reviewers keep `tools: Read, Grep, Glob` and their
  tool-call budgets, or the savings evaporate.
- **Don't auto-load big docs** — guardrail docs are read on a trigger, never `@-imported`.
  See [CONVENTIONS.md](CONVENTIONS.md).

## Developing the kit itself

```
pnpm install
pnpm dogfood                               # link the kit into .claude/ (gitignored) so this repo runs its own kit
pnpm test                                  # node:test suite incl. end-to-end init on fixtures
node cli/index.mjs init --dry-run --yes <some-repo>
pnpm change                                # record a changeset for your change (dogfood)
```

`cli/` may use dependencies; **everything under `payload/` is copied into user repos and must
stay zero-dependency node builtins**. Releases: changesets → the release workflow opens a
"Version Packages" PR → merging it publishes to npm (needs an `NPM_TOKEN` repo secret).
