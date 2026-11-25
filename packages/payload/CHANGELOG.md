# @houserules/payload

## 0.8.2

### Patch Changes

- 3732f6a: Stop hooks no longer count edits the user rejected at the permission prompt as changes made in the turn.

## 0.8.1

### Patch Changes

- dc02aae: Manual mode support: hooks, skills, and agents ignore rejected edits, stop rewriting files unprompted, and warn before subagent fan-out.

## 0.8.0

### Minor Changes

- 7ac34e1: Add @houserules/plugin-wireit, and move wireit specifics out of core scripts into plugin-written extension fragments.

### Patch Changes

- 7ac34e1: Payload scripts share one `repoRoot`, and `requireRepoRoot` refuses outside a git work tree.
- 7ac34e1: Add `verify.rootCommands`, root scripts that `verify-changed` runs after every package job.

## 0.7.0

### Minor Changes

- 1deb8dc: Add `plan-state.mjs` (`show`, `set`) and `plan-scaffold.mjs`, which creates a plan workspace that passes plan-lint.
- d5b8480: verify-changed `--run` starts independent package jobs together, and `verify.concurrent: false` restores the serial order.
- 577ec59: Orchestrate briefs cap each worker test pool at a wave share, which `wave-ceiling.mjs` now computes at two workers per core.
- 960b086: `wave-ceiling.mjs` prints a script `budget` and `share` from a new `resource-budget` lib, and takes `--workers`.
- 1deb8dc: Add `verify-changed --paths` and `--full`, a who-verifies table, and `verify.relatedCommand` file-level tests, which worker loops use unless `orchestrate.fileLevelAcceptance` is false.
- 1deb8dc: Research module adds a research-orchestrator, thread-scoped researchers, `fetch-batch`, JSONL records, and `check-findings --verify-urls` on the host turndown.

### Patch Changes

- 960b086: Hooks find the repo root by walking up to `.git` instead of spawning git.

## 0.6.0

### Minor Changes

- eac8920: Stop fixer skips missing scripts, and opt-in `fix.passPaths` scopes fixes to changed files.

## 0.5.1

### Patch Changes

- 2b40197: Changeset gate no longer flags absorbs and major bumps the user approved.

## 0.5.0

### Minor Changes

- 2161dc4: The research module ships a finding format, its checker, and a synthesis scaffold.
- 2161dc4: Checkers fail and name the path when a file argument cannot be read.

## 0.4.2

### Patch Changes

- 482a44d: Orchestrate caps each wave at a machine-derived worker ceiling, settable via orchestrate.maxWorkers.
- 482a44d: Changeset gate skips ignored, private, and unshipped-file packages, scopes to the turn, and honors changesets.gateIgnore.

## 0.4.1

### Patch Changes

- 77142ce: Lint/format Stop hook now fixes only files modified during the ended turn.

## 0.4.0

### Minor Changes

- f00d21d: Stop hooks skip a turn whose tool uses were all read-only.

### Patch Changes

- decb5e4: verify.timeoutMs caps each verify command, and verify-changed runs in the background instead of a subagent.
- 3be211a: claudeProjectDir resolves a project directory past 200 characters by prefix match
- cdc66de: Managed block honors an existing AGENTS.md; instructionsFile config forces either file.
- f00d21d: Ledger scripts read CLAUDE_CODE_SESSION_ID and encode the project directory like Claude Code.

## 0.3.2

### Patch Changes

- d963842: design.mjs tries every Tailwind entry, names skipped ones, and honors design.themeEntry.

## 0.3.1

### Patch Changes

- 5a0f02c: Prose voice requires American English and prose-lint flags British spellings.

## 0.3.0

### Minor Changes

- f5607f0: Bash guard blocks git checkout, restore, reset --hard, clean, and switch -f by default.

## 0.2.3

### Patch Changes

- 4a119d0: Rule-conformance fixes: tighter test helper types, corrected comments and shipped prose.

## 0.2.2

### Patch Changes

- c3268ac: Skills, rules, and rendered CLAUDE.md sections now forbid citing ledger ids in public text.

## 0.2.1

### Patch Changes

- 6a5152b: External dependency versions are now managed through the pnpm workspace catalog.

## 0.2.0

### Minor Changes

- cb34f11: Share ledger guard helpers from entry-ledger, ending drifting local copies across scripts

## 0.1.1

### Patch Changes

- 269dd06: Memoize repo-root resolution and drop duplicate git spawns from hot hooks

## 0.1.0

### Minor Changes

- 359e22c: Initial release. The shared libraries houserules copies into `.claude/scripts/lib/` and runs on bare node.

  Nine modules. `config` reads `houserules.config.json` defensively and never throws, `workspaces` enumerates workspace packages, `proc` wraps git and process calls, and `backlog-id`, `entry-ledger`, and `ledger-index` carry the ledger format. Three serve checkers: `findings` is the shape a checker reports and how it prints, `comment-scan` extracts comments without misfiring on comment-like text inside strings and regex literals, and `markdown-segment` separates markdown prose from code and quoted examples.

  Zero runtime dependencies and node builtins only, because these execute inside a user's repo on every hook. A plugin's payload script imports them by package name, and the `houserules-payload` bin rewrites the specifier to the relative form the flattened `.claude/scripts/` layout needs.
