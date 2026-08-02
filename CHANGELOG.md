# claude-kit

## 1.3.0

### Minor Changes

- 8bc445f: /plan-project stops after scaffolding instead of starting phase 1
- 8bc445f: doctor splits a settled local edit from a conflict, so an intentional edit no longer warns

### Patch Changes

- 8bc445f: Testing rule now forbids looping over assertions, naming it.each and collect-then-assert as the fixes.

## 1.2.0

### Minor Changes

- a7eb731: Add optional testing module: path-scoped rule for colocated unit tests and behavioral test names.
- c920010: Add opt-in prose-voice rule and rewrite kit prose in plainer sentences.
- 063b1d0: Rewrite the code-comments rule: TSDoc for exported API, no file headers, no landmark dividers.
- ac4e875: Add the code-cleanliness module: path-scoped rule, pull-only design-principles reference, and /tidy skill.

### Patch Changes

- c920010: Fix CONVENTIONS.md sections listing shipped modules as unbuilt and a wrong template path.
- 5aa693d: doctor now exits 2 with the schema errors on a malformed kit.config.json instead of crashing.
- 202a46c: Scope task-worker slice acceptance to owned paths instead of the whole repo
- 86d566b: Scope prose-voice to source files too, so code-comments no longer defers to an unloaded rule.

## 1.1.0

### Minor Changes

- 696a40d: Gitignore .claude/scripts by default, guard hooks against missing scripts, dedupe payload helpers.
- 0f3949f: Orchestrate skill prescribes a Slice/Owns/State status table between waves (KIT-9b7155).

### Patch Changes

- 696a40d: Fix pnpm workspace parsing: flow sequences, recursive ** globs, and !negations.

## 1.0.0

### Major Changes

- 9bda16c: Add a single-command interactive installer and changesets-canonical changelogs.

### Minor Changes

- e6d1957: Add the opt-in regen module rerunning a generator when matching files are edited (8efaf3).
- e6d1957: Backlog module injects a referenced entry's record when a prompt names its ID (0ad172).
- 115ce51: changeset authoring now requires the official changesets library.
- 957e95f: Add the code-comments module: a path-scoped .claude/rules comment-discipline rule.
- e6d1957: update prunes retired kit files and unwires their hooks (9d309f).
- e6533a6: Add a `modules` command to list installed vs available modules and enable more after init.
- a260ae1: Doctor's resident-context measure now counts .claude/CLAUDE.md, CLAUDE.local.md and globless rule files.
- e6d1957: Add an optional per-extension gate skipping fix commands on unmatched edits (ecaff8).
- Rewrite the CLI in TypeScript; bin is now dist/cli.js and Node 22+ is required.
- e6d1957: Add the persona-auditor agent template that blind-ranks options before reconciling (1df1b2).
- 1317633: Add the opt-in orchestrate module: /orchestrate skill + sonnet task-worker agent.
- e6d1957: update advertises new default modules an existing install lacks (e68b1f).
- e6d1957: Add the /ready skill emitting a pre-handoff verdict and acceptance checklist (8c7e00).
- e6d1957: Add the /review-change skill dispatching per-target reviewers by changed path (320464).
- e6d1957: Add the opt-in kit-aware statusline showing changeset debt and targets-touched (d9c7ca).
- e6d1957: Add the /sweep skill sharding mechanical edits into per-package writer subagents (743924).
- e6d1957: Add the claude-kit report command for cost-weighted transcript telemetry (715c23).
- 115ce51: Seeded CLAUDE.md, CLAUDE.additions.md, and the CLAUDE.md.template now ship a "Cost & verification discipline" section.
- a9aa735: Add opt-in debug-session module: hypothesis-driven trace-logging debug loop with complete instrumentation cleanup (CLAUDEKIT-564f18).
- e6d1957: Add the opt-in read-guard module redirecting unbounded reads of generated or oversized files (97b39e).
- Validate kit.config.json against a zod schema; ship a generated JSON Schema for editor completion.
- e6d1957: Add the /blast-radius skill archiving a dated impact map under .claude/plans/ (d581ae).
- Maintain kit sections as a marked block in CLAUDE.md, and support disabling modules.
- 4440632: Add plans module with /plan-project skill for persisting multi-phase work.
- e6d1957: Add the /verify-changed skill for off-context diff-scoped package verification (217f59).
- 1a92aed: lint-fix no longer fixes on SubagentStop by default; /orchestrate runs one fix pass per wave.
- Report drift with diffs and reconcile it via doctor --fix, distinguishing stale from your edits.
- Author payload hook scripts in TypeScript, compiled to dependency-free .mjs.
- Scope CLI flags per subcommand via commander; add doctor --json and a documented exit-code contract.

### Patch Changes

- ae98427: Add ESLint and Prettier.
- 957e95f: Document the seven undocumented modules in the README table; dogfood now sets outputStyle "Kit Terse".
- 9bda16c: Add initial kit.
- e6d1957: lint-fix skips wiring Stop hooks when no target has a fix command (dfdc87).
- 0bc9d34: guard-bash now tolerates flags before git commit/stash (so `git -C /repo commit` is blocked) and matches only command-position git/gh subcommands (so a read-only `grep "git commit"` is no longer blocked).
- bf34ff9: changeset-check no longer nudges for BACKLOG.md/CHANGELOG.md churn — generated ledgers are excluded from package-source detection.
- e6d1957: init refuses installs below the git toplevel with a cd fix (5ee4cc).
- e6533a6: Changeset summaries are now written as a single sentence describing the change.
- e6533a6: Stage a self-ignoring .gitignore inside .claude/kit-templates/ so the reference scaffolding stays on disk but out of commits, without touching the repo's own .gitignore.
- e6d1957: doctor reports resident-context budget, uncovered workspace packages, and terse-style status (d1284a, 8192cd, 7685bf).
- e6533a6: Terse style now documents its exact "Kit Terse" activation value so the filename slug no longer silently fails.
- e6533a6: Stage the archivist agent template only when the opt-in ledger module is enabled, and point the seeded CLAUDE.md and additions file at kit-templates/CLAUDE.md.template.
- 8123a02: /orchestrate takes an explicit plan slug and resolves ambiguous plans instead of guessing.
- e6533a6: doctor now warns when reference templates were committed before the kit ignored them, and update untracks them from git (keeping them on disk); template pointers note that npx claude-kit update restores the gitignored references.
- e6d1957: Record kit-contributed settings signatures in the manifest for safe reconcile (a4ed02).
- 0bc9d34: init generates a working lint-fix config for single-package repos: filterFlag is empty (no broken `--filter`) and a write-only `format` script is detected as a fixer.
- e3162da: changeset-write.mjs now authors changesets with the repo's own @changesets/write.
- 43ae341: Wrap CLI output to the terminal; next steps print outside the plan box.
- a260ae1: Doctor's missing-verify-block WARN now prints the exact block instead of advising a no-op update.
