# @houserules/cli

## 0.9.2

### Patch Changes

- 9347cf7: Install docs lead with `pnpm create @houserules`.

## 0.9.1

### Patch Changes

- 9764727: `npm create @houserules` installs the cli and runs init, replacing the unpublishable `houserules` shim.

## 0.9.0

### Minor Changes

- c06a17e: /orchestrate runs each phase one layer down on a sonnet phase-orchestrator by default, `--flat` opts out.
- 940ec16: plan-project records decisions not code and names the execution mode; plan-lint warns on code-heavy phase files.
- 3be211a: plan-project runs a read-only plan-reviewer agent once at handoff
- 940ec16: workerTools takes mcp__<server> patterns and doctor warns when a rule names an uncovered MCP tool.
- 940ec16: doctor warns on SKILL.md bodies over the 20 KB re-injection cap, orchestrate skill now fits.
- 940ec16: doctor reports the measured resident prompt from the newest local transcript snapshot beside its estimate.
- 940ec16: Guard hooks carry onFailure: block, so a crashed guard fails closed on Claude Code 2.1.295+.
- decb5e4: verify.timeoutMs caps each verify command, and verify-changed runs in the background instead of a subagent.
- 940ec16: New optional tool-output-trim module: a PostToolUse hook caps Bash and Read results over 16 KiB to head plus tail.
- 3be211a: tidy runs its audit in a subagent and applies findings in the main context
- 8f3623d: Dispatching skills treat a stalled subagent as unreviewed, and subagents background long commands.
- 3be211a: doctor warns on a plugin peer range the CLI does not satisfy instead of exiting
- 940ec16: report breaks nested rule and CLAUDE.md loads down by file and by main chain versus subagents.
- c06a17e: `houserules report` adds wall clock, main-versus-subagent, and per-model token lines per session.
- 940ec16: doctor checks the running Claude Code version against the floor each installed module needs.
- 3be211a: sweep asks before dispatching more than 8 shards
- cdc66de: Managed block honors an existing AGENTS.md; instructionsFile config forces either file.
- 3be211a: brief-driven reviewer and writer agents skip CLAUDE.md with omitClaudeMd
- 3be211a: plan template carries a Review Focus section that plan-lint checks
- 940ec16: Retired the task-worker low and xhigh variants; /orchestrate passes effort per slice through the Agent tool.

### Patch Changes

- f00d21d: lint-format-fix yields to running background tasks and caps its fix steps at 90 seconds.
- f00d21d: report prints its session date window and warns when retention trimmed it.
- 3be211a: doctor lists only payload-shipping siblings as plugins available beside the CLI
- f00d21d: report friction ignores read-only git status and diff checks.
- f00d21d: Stop hooks skip a turn whose tool uses were all read-only.
- 940ec16: ledger-inject frames injected ledger text as data, with control characters stripped and a per-run end marker.
- f00d21d: doctor's resident budget skips hidden skills and reads the active output style from settings.
- 0da93ca: /orchestrate's single-file acceptance form now carries the `--` wireit needs to forward the path.
- f00d21d: verify-changed prints SKIPPED for a package with no verify commands.
- f00d21d: Hook wrappers choose their missing-script fallback by event instead of one shared exit 1.
- f00d21d: report breaks resident-context medians out by session entrypoint.
- f00d21d: doctor warns on a local hook override only when its command differs from the managed one.
- 3be211a: ci-settings states the deny list stands alone under --bare
- f00d21d: The managed CLAUDE.md region renders tables prettier leaves unchanged.
- f00d21d: doctor no longer flags every installed hook as unguarded.
- 940ec16: Shorter tidy and verify-changed descriptions, user-run skills left out of the listing, Prose style allows one line around tool work.
- f00d21d: Shipped agents bound their Bash use and name the hand-back tool.
- 5f2ee8b: Report exports no longer keep paths from leading variable assignments or path-shaped executables.
- 3be211a: report ledger outcomes read the synced index when the local ledger is pruned
- 3be211a: claudeProjectDir resolves a project directory past 200 characters by prefix match
- 0da93ca: ledger-inject no longer injects on subagent hand-backs and background task notices.
- f00d21d: guard-bash gates subagent writes on the hook input's agent_id.
- Updated dependencies [940ec16]
- Updated dependencies [f00d21d]
- Updated dependencies [940ec16]
- Updated dependencies [decb5e4]
- Updated dependencies [f00d21d]
- Updated dependencies [3be211a]
- Updated dependencies [cdc66de]
- Updated dependencies [f00d21d]
  - @houserules/api@0.6.0
  - @houserules/payload@0.4.0

## 0.8.0

### Minor Changes

- f3f5ecc: report gains --json, --since, redacted --export, multi-machine --import, and a resident-context section

## 0.7.0

### Minor Changes

- d963842: orchestrate.workerTools appends MCP tool names to every task-worker's tools line.
- d963842: orchestrate installs a task-worker-research variant carrying WebFetch and WebSearch by default.

### Patch Changes

- d963842: design.mjs tries every Tailwind entry, names skipped ones, and honors design.themeEntry.
- Updated dependencies [d963842]
- Updated dependencies [d963842]
  - @houserules/api@0.5.0
  - @houserules/payload@0.3.2

## 0.6.1

### Patch Changes

- Updated dependencies [5a0f02c]
  - @houserules/payload@0.3.1
  - @houserules/api@0.4.1

## 0.6.0

### Minor Changes

- f5607f0: Bash guard blocks git checkout, restore, reset --hard, clean, and switch -f by default.

### Patch Changes

- 4b0520d: Report telemetry now covers subagent transcripts, hook crashes, and per-machine scope of unused skills.
- 88280e6: Bump @clack/prompts to 1.8.0 and adapt the cancel guard to its narrower isCancel typing.
- 3f1240c: Payload hook scripts export their decision functions, tested directly.
- Updated dependencies [f5607f0]
  - @houserules/api@0.4.0
  - @houserules/payload@0.3.0

## 0.5.0

### Minor Changes

- 8afd19d: New optional research module installs research-spike, research-synth, and refactor-planner agents for planned phases.
- 67f79ed: Doctor and the managed CLAUDE.md block now surface the subdirectory-session hook bypass.
- 8afd19d: Orchestrate module option installs generated task-worker effort variants (low, high, xhigh).

### Patch Changes

- e351770: Deduplicate orchestrate skill prose between SKILL.md and its reference files.
- 4a119d0: Rule-conformance fixes: tighter test helper types, corrected comments and shipped prose.
- a6e2f46: Add guardrails against truncated spec reads and over-verification in live debug loops.
- Updated dependencies [4a119d0]
  - @houserules/api@0.3.3
  - @houserules/payload@0.2.3

## 0.4.1

### Patch Changes

- 01cd6e4: The CLAUDE.md region's five skill sections collapse into imperative one-line triggers.

## 0.4.0

### Minor Changes

- 459999a: Doctor reports path-scoped rule and on-invoke skill and agent prose weight.
- 459999a: plan-lint flags plan-doc file paths that do not exist in the repo.
- 459999a: Doctor scans settings hooks and config for hygiene problems and secret-shaped values.

### Patch Changes

- 459999a: Rendered verification discipline lists recorded completion-claim evasions with answers.
- 459999a: Skill descriptions no longer narrate the skill's internal steps.
- c3268ac: Skills, rules, and rendered CLAUDE.md sections now forbid citing ledger ids in public text.
- Updated dependencies [c3268ac]
  - @houserules/payload@0.2.2
  - @houserules/api@0.3.2

## 0.3.2

### Patch Changes

- d834e38: Orchestrate and ready skills fall back gracefully when no backlog plugin is installed.

## 0.3.1

### Patch Changes

- 0e49523: blast-radius fans out through a dedicated read-only sonnet mapper agent

## 0.3.0

### Minor Changes

- b986353: orchestrate wires optional skills into its lifecycle and gains a context-size gate
- f73b0fc: `houserules report` adds hook, guard, skill, outcome, and friction sections plus repeatable `--slug`.

### Patch Changes

- 67870fc: doctor verifies every installed script's imports resolve

## 0.2.3

### Patch Changes

- 6a5152b: External dependency versions are now managed through the pnpm workspace catalog.
- Updated dependencies [6a5152b]
  - @houserules/api@0.3.1
  - @houserules/payload@0.2.1

## 0.2.2

### Patch Changes

- e11c60f: Merge backups moved to a gitignored .claude/backups/ directory.
- e11c60f: Three.js upstream docs now cover only the chosen framework bindings.
- e11c60f: The ledger directory is only created when a ledger-consuming plugin is installed.
- Updated dependencies [e11c60f]
  - @houserules/api@0.3.0

## 0.2.1

### Patch Changes

- 7b5f72a: Adopt the Jest-standard **tests** directory name for test colocation.

## 0.2.0

### Minor Changes

- cb34f11: reviewers module ships review-package.mjs, packaging a commit range into one reviewable file
- cb34f11: Update refreshes kit-wired hook entries, hookFragment carries if/timeout/async, one merged Bash gate

### Patch Changes

- cb34f11: Drop duplicate payload peerDependencies, dedupe naming clause into code-cleanliness, take clack 1.x
- cb34f11: Share ledger guard helpers from entry-ledger, ending drifting local copies across scripts
- Updated dependencies [cb34f11]
- Updated dependencies [cb34f11]
  - @houserules/payload@0.2.0
  - @houserules/api@0.2.0

## 0.1.2

### Patch Changes

- 269dd06: Fix wireit check inputs so tsconfig and payload-test edits re-run typecheck
- 269dd06: Fix doctor resolution for exports-gated plugins, budget nested skills and output styles, install orchestrate reference files
- Updated dependencies [269dd06]
- Updated dependencies [269dd06]
  - @houserules/payload@0.1.1
  - @houserules/api@0.1.1

## 0.1.1

### Patch Changes

- afc7ff6: Resolve npm-installed plugins whose exports map does not expose `./package.json`.

## 0.1.0

### Minor Changes

- 359e22c: Initial release. An interactive installer for a portable Claude Code context-discipline houserules.

  `houserules init` detects the repo, plans a set of declarative actions, previews them, and applies. Sixteen built-in modules cover hooks, skills, agents, rules, and reference docs. Ownership is explicit: houserules-owned files are manifest-tracked and refreshed by `update`, seeds belong to you and are never overwritten, and a managed region means houserules writes only between its markers in a file you own.

  `houserules doctor` audits an install: config validity, context budget, drift against the manifest, fix and verify script wiring, whether a read-only agent grants an unbounded Bash, and whether every installed reference doc is reachable from something else houserules installed. `--fix` reconciles and `--prune` removes what no enabled module produces.

  Plugins extend houserules. Declare one in `.claude/houserules.config.json` under `plugins` and its modules become selectable as `<alias>/<moduleId>`. A plugin codes against `@houserules/api` rather than against this package, so the installer stays out of its dependency graph. `CONVENTIONS.md` documents the contract, including how a plugin's payload reaches a shared lib.

  Ships the planning and orchestration skills: `/plan-project` persists a multi-phase plan, `/orchestrate` executes a phase by fanning out scoped implementer subagents, and `/verify-changed`, `/ready`, `/sweep`, and `/blast-radius` cover verification and wide changes.

### Patch Changes

- Updated dependencies [359e22c]
- Updated dependencies [359e22c]
  - @houserules/api@0.1.0
  - @houserules/payload@0.1.0

## 0.1.0

Initial release. An interactive installer for a portable Claude Code context-discipline houserules.

Detects a repo read-only, previews every file and settings change, then applies. A manifest of
content hashes lets `update` refresh kit-owned files without touching yours, and `doctor`
reports drift or reconciles it with `--fix`.

Ownership splits inside a file as well as between files. houserules maintains a marked region in
CLAUDE.md and owns a rule's body under frontmatter you control. Bytes outside those spans are
never modified.

Ships 15 core modules. Hooks guard destructive git commands, auto-fix changed packages, and
inject session context. Skills cover planning, orchestration, diff-scoped verification, review,
and cleanup.

Plugins extend houserules through `@houserules/cli/plugin`. A plugin contributes modules that
return the same declarative actions the built-ins do, and ships its own payload. The six
first-party plugins carry the rules, ledgers, and output style that used to be built in.
