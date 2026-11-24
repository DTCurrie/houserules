# @houserules/cli

## 0.20.0

### Minor Changes

- ff260b8: New mod guard refuses agent writes into Claude Code mod directories in modes that do not prompt.

### Patch Changes

- ff260b8: Research briefs carry the synthesis id prefix, spikes skip sibling pages directories, and each task-worker uses its own scratch directory.
- ff260b8: verify-changed labels its root entry `<root>`, so a package named like the root no longer collides.
- ff260b8: Doctor's upgrade command adds `-w` whenever pnpm-workspace.yaml exists, matching the session hook.
- ff260b8: detect() runs one git spawn on a repo with commits.
- ff260b8: Bash guard refuses git commit, push, stash and discard behind wrapper commands or a computed `git $(...)`.
- ff260b8: The synthesis scaffold resolves a report path from any working directory.
- ff260b8: A guard.custom rule without a message refuses with a default reason naming the missing field.
- ff260b8: report names the scripts behind a dispatched Stop hook, and compare mode shows hook run-log rows.
- ff260b8: check-findings --verify-urls finds quotes across footnotes, math and invisible characters, and flags added trailing punctuation.
- ff260b8: Hook dispatch keeps JSON on exit 2 and adds plain-text context only on events that read it.
- Updated dependencies [ff260b8]
  - @houserules/api@0.12.0
  - @houserules/payload@0.8.1

## 0.19.0

### Minor Changes

- dc02aae: Manual mode support: hooks, skills, and agents ignore rejected edits, stop rewriting files unprompted, and warn before subagent fan-out.

### Patch Changes

- Updated dependencies [dc02aae]
  - @houserules/payload@0.8.1
  - @houserules/api@0.11.1

## 0.18.0

### Minor Changes

- 7ac34e1: `doctor` reports each resident surface against its documented limit, with no summed budget.
- 7ac34e1: A `notice-interim` hook tells the session to answer an interim subagent notice in one line.
- 7ac34e1: `report` compare mode shows Bash wall time and kit versions.
- 7ac34e1: Add @houserules/plugin-wireit, and move wireit specifics out of core scripts into plugin-written extension fragments.
- 7ac34e1: Add `verify.rootCommands`, root scripts that `verify-changed` runs after every package job.
- 7ac34e1: Settings hold one hook dispatcher entry per event, with the hook wiring in `.claude/scripts/hook-wiring.json`.
- 7ac34e1: The hook dispatcher keeps a local run log, and `report` reads Stop hook paths and Bash guard duration from it.

### Patch Changes

- 7ac34e1: `report` files a Bash loop, chain or pipe under the command it ran.
- 7ac34e1: Orchestrate and plan-project references cover agent-type retries, milestone build readers and the `DROPPED` status.
- 7ac34e1: The dry-run preview lists the backup and manifest files, under a clearer next-steps header.
- 7ac34e1: The Bash guard parses commands as a shell does, catching substituted commits and allowing quoted mentions.
- 7ac34e1: The version-check cache stays ignored when `payload.commit` is true.
- 7ac34e1: `init` fills a config's absent top-level keys from the seed.
- 7ac34e1: The verification rules say when a check is done and when a draft needs none.
- 7ac34e1: A plugin that fails to resolve prints one line and no stack.
- 7ac34e1: The hook dispatcher ranks `defer`, keeps JSON from a failed hook, uses per-event timeouts, and stops waiting on held pipes.
- 7ac34e1: The sync hook and `doctor` agree on when to skip the update check and which upgrade command to print.
- 7ac34e1: `update` and `doctor` read the git index once per run.
- 7ac34e1: `verify-changed` degrades to full scope when git status or diff fails.
- Updated dependencies [7ac34e1]
- Updated dependencies [7ac34e1]
- Updated dependencies [7ac34e1]
- Updated dependencies [7ac34e1]
- Updated dependencies [7ac34e1]
  - @houserules/payload@0.8.0
  - @houserules/api@0.11.0

## 0.17.0

### Minor Changes

- 960b086: `houserules eject` takes ownership of an installed file, `eject --undo` gives it back, and `rules.<id>.paths` overrides a rule's globs.
- 960b086: The installed payload is gitignored by default, and `payload.commit` keeps it tracked.
- 1deb8dc: Add `plan-state.mjs` (`show`, `set`) and `plan-scaffold.mjs`, which creates a plan workspace that passes plan-lint.
- 960b086: The `houserules report` Bash wall section gains an `unscoped calls` column.
- d5b8480: verify-changed `--run` starts independent package jobs together, and `verify.concurrent: false` restores the serial order.
- 960b086: A SessionStart hook syncs the install to the pinned CLI version.
- d031728: The reviewers module installs a read-only diff-reviewer agent that `/orchestrate` runs at large wave barriers and at phase close.
- 577ec59: Orchestrate briefs cap each worker test pool at a wave share, which `wave-ceiling.mjs` now computes at two workers per core.
- 960b086: `wave-ceiling.mjs` prints a script `budget` and `share` from a new `resource-budget` lib, and takes `--workers`.
- 1deb8dc: Add `verify-changed --paths` and `--full`, a who-verifies table, and `verify.relatedCommand` file-level tests, which worker loops use unless `orchestrate.fileLevelAcceptance` is false.
- 960b086: `houserules update` migrates an install with a committed payload to the ignored layout.
- 960b086: Session start prints the kit version and a daily notice of a newer release, which `versionCheck` turns off.
- 1deb8dc: Research module adds a research-orchestrator, thread-scoped researchers, `fetch-batch`, JSONL records, and `check-findings --verify-urls` on the host turndown.
- 960b086: `init` turns `fix.passPaths` on when the fix scripts take paths.
- 960b086: `houserules report` gains a Bash wall time section.
- 1688ed9: Milestone runs write the step two ahead at each flip, and plan-lint checks it.
- 1deb8dc: Add an orchestrate reference for dispatching a few disjoint slices without a plan workspace.
- 960b086: The managed CLAUDE.md region is now an `@` import of `.claude/houserules.md`.

### Patch Changes

- b349bee: plan-project grounding now stops at the first plan write.
- 577ec59: `/verify-changed` passes the script budget fan-out to its children unless the caller already set one.
- 960b086: Milestone runs write one changeset per feature at each barrier.
- 960b086: Orchestrate wave barriers rerun slice acceptances and typecheck, and the full verify runs once per phase.
- 960b086: `init` validates the config it writes.
- d031728: `plan-reviewer` takes a `Level:` line, `milestone`, `plan`, or `phase`, and reads one sub-plan at `phase`.
- 960b086: A milestone step item skips `/verify-changed` at its phase close, and the step barrier carries the check.
- 960b086: verify-changed treats a timeout in an overlapped run as load and reruns it alone.
- d031728: `task-worker` and `phase-orchestrator` write their report prose as fragments and keep commands, numbers, errors, and negations whole.
- Updated dependencies [960b086]
- Updated dependencies [960b086]
- Updated dependencies [1deb8dc]
- Updated dependencies [960b086]
- Updated dependencies [d5b8480]
- Updated dependencies [960b086]
- Updated dependencies [577ec59]
- Updated dependencies [960b086]
- Updated dependencies [1deb8dc]
- Updated dependencies [960b086]
- Updated dependencies [960b086]
- Updated dependencies [1deb8dc]
- Updated dependencies [960b086]
  - @houserules/api@0.10.0
  - @houserules/payload@0.7.0

## 0.16.0

### Minor Changes

- 1ab1be5: Milestones group plans into ordered steps, and `plan-lint` checks them and prints their gates.
- e5d8da6: `closeout.mjs` checks a plan's checklist, `Closes` lines, and report sources.
- e5d8da6: A `closeout-worker` agent runs a plan's closeout from a new `plan-project` template.
- e5d8da6: Plan phases can carry a `flat` signal that runs them in the dispatcher's own context.
- eac8920: `update` refreshes stale generated scripts and templates instead of keeping them as edits.
- eac8920: Stop fixer skips missing scripts, and opt-in `fix.passPaths` scopes fixes to changed files.

### Patch Changes

- 1ab1be5: `/orchestrate`, review, and verify skills wait on subagents in the foreground without stalling.
- eac8920: The install manifest records plugins without absolute paths, and `update` keeps them.
- eac8920: `plan-lint` checks plan paths under every top-level directory and target prefix.
- eac8920: `report --export` carries counts describing the install's fix setup.
- e5d8da6: `report --export` carries each session's weighted input.
- eac8920: CLI usage errors print their message without a stack trace.
- eac8920: `doctor` flags hooks whose `$CLAUDE_PROJECT_DIR` script is missing.
- e5d8da6: The Bash guard allows read-only `git stash list` and `git stash show`.
- e5d8da6: `update` exits 2 on a `houserules.config.json` the schema rejects.
- e5d8da6: `report` names the exporting CLI version in a single import's heading.
- e5d8da6: Workers draft under another name when a report-named `Write` is refused.
- eac8920: The trim readout reports bytes above the cap per tool.
- e5d8da6: The Stop fixer kills its whole process group on timeout.
- e5d8da6: `doctor` warns when a SessionStart or Stop hook exits 1 on a missing script.
- e5d8da6: `report` lists each timed-out Stop hook run with its date and session.
- eac8920: `report --export` keeps guard block reasons with private paths and patterns masked.
- eac8920: `report` prices Claude Haiku 4.5.
- Updated dependencies [eac8920]
- Updated dependencies [eac8920]
  - @houserules/api@0.9.0
  - @houserules/payload@0.6.0

## 0.15.0

### Minor Changes

- 60517b4: `init`, `update`, and `modules` install the modules a selected module requires.
- 60517b4: `doctor` warns when an installed module's requirement is missing.
- 34028da: Phases needing extra tools nest via `orchestrate.orchestratorTools`, or run flat without it.
- 60517b4: `orchestrate` now requires `plans` and `sweep`, so selecting it installs both.
- 34028da: Add a `live` phase signal that `/orchestrate` runs alone and `plan-lint` checks.

### Patch Changes

- 60517b4: `doctor` warns when the managed CLAUDE.md block names a missing `.claude/` path.
- 60517b4: `init` and `update` previews list the managed block's added and removed lines.
- 60517b4: Skills, rules, and templates now say what happens when a module they mention is absent.
- 60517b4: The design bullet, now written by plugin-design, points `design-tailwind` repos at their Tailwind theme.
- 60517b4: `update` removes dangling symlinks at installed file paths.
- 34028da: Concurrent phase-orchestrators no longer run package-wide verifies at their barriers.
- Updated dependencies [60517b4]
- Updated dependencies [34028da]
- Updated dependencies [2b40197]
- Updated dependencies [60517b4]
  - @houserules/api@0.8.0
  - @houserules/payload@0.5.1

## 0.14.0

### Minor Changes

- 2161dc4: The research module ships a finding format, its checker, and a synthesis scaffold.

### Patch Changes

- 2161dc4: A nested orchestrator is resumed only after its finished notice, with SendMessage as its fallback.
- 2161dc4: report writes a zero-session export and exits 0 when --since cuts every session.
- 2161dc4: doctor compares versions one way and warns on a prerelease below the floor.
- 2161dc4: CLAUDE.md points UI and artifact work at the design token file when the design module is installed.
- 2161dc4: doctor prints transcript retention, and report reads the real cleanupPeriodDays.
- 2161dc4: The debug-session skill description leads with its trigger.
- 2161dc4: report guard efficacy opens with a per-guard summary and shortens command previews to 80 characters.
- 2161dc4: report shows the count and share of Stop hook runs over one second.
- 2161dc4: Checkers fail and name the path when a file argument cannot be read.
- Updated dependencies [2161dc4]
- Updated dependencies [2161dc4]
- Updated dependencies [2161dc4]
  - @houserules/api@0.7.3
  - @houserules/payload@0.5.0

## 0.13.0

### Minor Changes

- fb9eb89: `report` shows `Read` and `Bash` result sizes against the `tool-output-trim` cap.
- fb9eb89: `report` times every Stop hook run, quiet ones included, per script and per Stop.
- fb9eb89: `report` adds an artifact episodes section.
- fb9eb89: `doctor` notes when the install and the running CLI both trail the published `latest`.
- fb9eb89: `plan-lint` warns on a slice row that is not `DONE` under a `DONE` phase.
- fb9eb89: `report` weighs 1-hour cache writes at 2x in its cost-weighted input.
- fb9eb89: `report` prints a list-price dollar figure for the corpus.

### Patch Changes

- fb9eb89: The `phase-orchestrator` keepalive is `sleep 270`, then `sleep 1800` after seven wakes.
- 9194d3d: `report` guard efficacy and hook health now count guard blocks.
- 9194d3d: `report` skill outcomes now match `/decide` fires to decision ledger entries.
- 9194d3d: The orchestrate context-size gate now fires past 300,000 tokens, before compaction.
- 9194d3d: Fix `report` counting each API response once per content block, roughly halving earlier totals.
- Updated dependencies [9194d3d]
- Updated dependencies [9194d3d]
- Updated dependencies [9194d3d]
  - @houserules/api@0.7.2

## 0.12.2

### Patch Changes

- 73b7d68: `/blast-radius` writes its impact map into the associated plan's workspace.

## 0.12.1

### Patch Changes

- a198513: Shorten the managed CLAUDE.md region and resident skill and agent descriptions.
- a198513: Retune agent and slice effort defaults for the current Claude models.
- a198513: Rules, skills, and agent prompts are reworded for the current Claude models.
- a198513: Rename script loads typescript lazily instead of failing doctor's import check.
- f83c4e8: The managed commit rule names only the actions the guard config still blocks.
- a198513: Doctor follows CLAUDE.md imports four hops deep, matching Claude Code.
- a198513: Bump commander, @clack/prompts, and semver to their latest minor and patch releases.
- a198513: Doctor raises its Claude Code floor to 2.1.314, or 2.1.321 for agents pinned to fable.
- a198513: Report excludes placeholder subagent token counts written by Claude Code before 2.1.307.
- Updated dependencies [a198513]
  - @houserules/api@0.7.1

## 0.12.0

### Minor Changes

- 482a44d: Orchestrate caps each wave at a machine-derived worker ceiling, settable via orchestrate.maxWorkers.

### Patch Changes

- 482a44d: Lint fixer now reaches files created in directories git has never tracked.
- Updated dependencies [482a44d]
- Updated dependencies [482a44d]
  - @houserules/api@0.7.0
  - @houserules/payload@0.4.2

## 0.11.0

### Minor Changes

- f2a4008: Phase orchestrator runs on opus and workers take model and effort from slice shape.

### Patch Changes

- 77142ce: Lint/format Stop hook now fixes only files modified during the ended turn.
- Updated dependencies [77142ce]
  - @houserules/payload@0.4.1
  - @houserules/api@0.6.1

## 0.10.0

### Minor Changes

- 4a79414: Independent phases marked with After and Domain run concurrently under /orchestrate, checked by plan-lint.

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
